/**
 * Reader for task-orchestrator workspaces.
 *
 * The orchestrator skill runs each Volo task in an isolated workspace at
 * `<root>/<task_code>/` and keeps an append-only event log at `events.jsonl`.
 * That log is the only place the *current phase* of a run exists — Volo knows
 * the task's column, AI Maestro knows it delegated the task, but neither knows
 * whether the agent is exploring, planning or waiting on a human checkpoint.
 *
 * Read-only by design. The workspace belongs to the orchestrator; this only
 * observes it, so a change to how runs are stored cannot be broken from here.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Where task workspaces live.
 *
 * Both spellings are checked because the skill documents `~/projects/jaak/`
 * while the ligo dashboard defaults to `~/Projects/jaak/`, and on a
 * case-sensitive filesystem only one of them exists.
 */
export function workspaceRoots(): string[] {
  const configured = process.env.LIGO_WORKSPACES_ROOT
  if (configured) return [configured.replace(/^~/, os.homedir())]
  return [
    path.join(os.homedir(), 'projects', 'jaak'),
    path.join(os.homedir(), 'Projects', 'jaak'),
  ]
}

export type EventKind =
  | 'fase_inicio'
  | 'fase_fin'
  | 'nota'
  | 'intervencion_humana'

export interface RunEvent {
  ts: string
  fase: string
  tipo: EventKind
  mensaje: string
  datos?: Record<string, unknown>
  /** Only on intervencion_humana. */
  actor?: string
}

export interface RunState {
  taskCode: string
  workspacePath: string
  /** Phase whose `fase_inicio` has no matching `fase_fin`. */
  currentPhase: string | null
  /** Message of the event that opened the current phase. */
  currentMessage: string | null
  /** True while the run sits in a human checkpoint. */
  awaitingHuman: boolean
  startedAt: string | null
  lastEventAt: string | null
  phasesCompleted: string[]
  eventCount: number
  /** Last few events, newest last, for a compact timeline. */
  recent: RunEvent[]
}

/**
 * Phases that exist to wait for a person.
 *
 * Surfaced separately because a run parked on a checkpoint is not progressing:
 * it is blocked on the operator, and showing it as "working" hides the fact
 * that nothing will happen until they answer.
 */
const HUMAN_CHECKPOINTS = new Set([
  'checkpoint_1',
  'checkpoint_2',
  'revision_preliminar',
  'revision_plan',
  'revision_pr',
])

/** Human-readable label for a phase id. */
export const PHASE_LABELS: Record<string, string> = {
  pre_vuelo: 'Pre-vuelo',
  configuracion: 'Configuración',
  preparacion_workspace: 'Preparando workspace',
  entrada_volo: 'Leyendo Volo',
  analisis_preliminar: 'Análisis preliminar',
  checkpoint_1: 'Esperando revisión preliminar',
  revision_preliminar: 'Esperando revisión preliminar',
  clonar_repos: 'Clonando repos',
  exploracion: 'Explorando',
  exploracion_local: 'Explorando',
  recoleccion_contexto: 'Recolectando contexto',
  reproducir_bug: 'Reproduciendo el bug',
  plan: 'Planificando',
  checkpoint_2: 'Esperando revisión del plan',
  revision_plan: 'Esperando revisión del plan',
  construccion: 'Construyendo',
  code_review: 'Revisión de código',
  verificacion_flujo: 'Verificando el flujo',
  entrega: 'Creando PR',
  revision_pr: 'Esperando revisión del PR',
  documentar: 'Documentando',
  handoff: 'Handoff',
}

export function phaseLabel(phase: string | null): string | null {
  if (!phase) return null
  return PHASE_LABELS[phase] || phase.replace(/_/g, ' ')
}

/**
 * Locate a task's workspace, or null when no run has been started.
 *
 * The task code arrives from a URL and picks the ROOT that every later
 * containment check is measured against, so it gets validated harder than a
 * name normally would.
 *
 * The code must START with a letter or a digit. The previous pattern allowed a
 * leading dot, which let `..` through: `path.join(root, '..')` is the parent
 * directory, it passes `isDirectory()`, and from then on the whole parent tree
 * counted as "inside the workspace". Checking containment against a root the
 * caller chose is not a check at all.
 *
 * The containment check after the join is belt and braces — the pattern
 * already forbids separators — but it keeps the guarantee next to the code
 * that depends on it instead of two functions away.
 */
export function findWorkspace(taskCode: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskCode)) return null

  for (const root of workspaceRoots()) {
    const prefix = root + path.sep
    const candidate = path.join(root, taskCode)
    if (!candidate.startsWith(prefix)) continue
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

/**
 * Parse the event log.
 *
 * Malformed lines are skipped rather than failing the read: the log is written
 * by a long-running process and a truncated final line is normal while a run is
 * in flight.
 */
function readEvents(workspacePath: string): RunEvent[] {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(workspacePath, 'events.jsonl'), 'utf-8')
  } catch {
    return []
  }

  const events: RunEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as RunEvent
      if (parsed?.ts && parsed?.fase && parsed?.tipo) events.push(parsed)
    } catch {
      /* partial write, or a line this version does not understand */
    }
  }
  return events
}

const RECENT_EVENTS = 8

/**
 * Current state of a task's run, or null when there is no workspace.
 *
 * The current phase is the last `fase_inicio` without a matching `fase_fin`.
 * The skill is explicit that `fase_inicio` is written before any work begins,
 * so this reflects what the agent is doing now rather than what it last
 * finished.
 */
export function readRun(taskCode: string): RunState | null {
  const workspacePath = findWorkspace(taskCode)
  if (!workspacePath) return null

  const events = readEvents(workspacePath)

  const open: string[] = []
  const completed: string[] = []
  let currentMessage: string | null = null

  for (const event of events) {
    if (event.tipo === 'fase_inicio') {
      open.push(event.fase)
      currentMessage = event.mensaje
    } else if (event.tipo === 'fase_fin') {
      const index = open.lastIndexOf(event.fase)
      if (index !== -1) open.splice(index, 1)
      completed.push(event.fase)
    }
  }

  const currentPhase = open.length > 0 ? open[open.length - 1] : null

  return {
    taskCode,
    workspacePath,
    currentPhase,
    currentMessage,
    awaitingHuman: currentPhase ? HUMAN_CHECKPOINTS.has(currentPhase) : false,
    startedAt: events[0]?.ts ?? null,
    lastEventAt: events[events.length - 1]?.ts ?? null,
    phasesCompleted: completed,
    eventCount: events.length,
    recent: events.slice(-RECENT_EVENTS),
  }
}

/** Task codes that have a workspace, newest first. */
export function listRuns(): string[] {
  const seen = new Map<string, number>()

  for (const root of workspaceRoots()) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const stat = fs.statSync(path.join(root, entry.name))
        seen.set(entry.name, stat.mtimeMs)
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }

  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * Where each phase writes, per the orchestrator's own layout rules.
 *
 * The order is the order of the run, so a listing reads as a timeline rather
 * than as an alphabetical directory dump.
 */
const ARTIFACT_CATEGORIES = [
  { dir: '', label: 'Corrida' },
  { dir: 'preparacion', label: 'Preparación' },
  { dir: 'entendimiento', label: 'Entendimiento' },
  { dir: 'diseno', label: 'Diseño' },
  { dir: 'construccion', label: 'Construcción' },
  { dir: 'entrega', label: 'Entrega' },
  { dir: 'cierre', label: 'Cierre' },
] as const

export interface Artifact {
  /** Path relative to the workspace root, e.g. `diseno/plan.md`. */
  path: string
  name: string
  category: string
  size: number
  modifiedAt: string
}

/**
 * Real, canonical root of a workspace, or null when it cannot be resolved.
 *
 * Symlinks are resolved here on purpose. `path.resolve` works on the text of
 * the path and does not follow them, so comparing against a non-canonical root
 * would let a link inside the workspace escape it.
 */
function workspaceRoot(workspacePath: string): string | null {
  try {
    return fs.realpathSync(path.resolve(workspacePath))
  } catch {
    return null
  }
}

/**
 * List the readable artifacts of a run.
 *
 * `repos/` is skipped: it holds full git clones, and walking them would turn a
 * listing into a filesystem crawl of somebody's entire codebase.
 */
export function listArtifacts(taskCode: string): Artifact[] {
  const workspacePath = findWorkspace(taskCode)
  if (!workspacePath) return []

  const artifacts: Artifact[] = []

  for (const { dir, label } of ARTIFACT_CATEGORIES) {
    const full = dir ? path.join(workspacePath, dir) : workspacePath
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(full, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue
      // Only text the panel can render. Screenshots and traces under
      // runtime-evidence are listed by their directory, not inlined here.
      if (!/\.(md|txt|jsonl|json)$/i.test(entry.name)) continue

      const relative = dir ? path.join(dir, entry.name) : entry.name
      try {
        const stat = fs.statSync(path.join(full, entry.name))
        artifacts.push({
          path: relative,
          name: entry.name,
          category: label,
          size: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
        })
      } catch {
        /* vanished mid-listing */
      }
    }
  }

  return artifacts
}

/** Largest artifact returned inline, to keep a response readable. */
const MAX_ARTIFACT_BYTES = 512 * 1024

export interface ArtifactContent {
  path: string
  content: string
  truncated: boolean
  size: number
}

/** Read one artifact. Returns null when it does not exist or escapes the root. */
export function readArtifact(
  taskCode: string,
  relativePath: string
): ArtifactContent | null {
  const workspacePath = findWorkspace(taskCode)
  if (!workspacePath) return null

  if (!relativePath || path.isAbsolute(relativePath)) return null

  const root = workspaceRoot(workspacePath)
  if (!root) return null

  // La contencion se comprueba DOS veces y aqui mismo, no en una funcion
  // aparte: primero sobre el texto de la ruta, y luego sobre el camino real,
  // porque path.resolve no sigue enlaces simbolicos y un enlace creado dentro
  // del workspace apuntando fuera pasaria la primera comprobacion. Estos
  // workspaces los escriben agentes que clonan repositorios, asi que ese
  // enlace no tiene que ponerlo un atacante.
  //
  // El startsWith va escrito aqui y no detras de un ayudante. El analisis
  // estatico sigue el dato desde el parametro hasta el acceso a disco, y una
  // comprobacion metida en otra funcion queda fuera de ese recorrido: protege
  // igual, pero ni el analizador ni quien lea esto la ven desde donde importa.
  const prefix = root + path.sep
  const candidate = path.resolve(root, relativePath)
  if (candidate !== root && !candidate.startsWith(prefix)) return null

  let file: string
  try {
    file = fs.realpathSync(candidate)
  } catch {
    return null
  }
  if (file !== root && !file.startsWith(prefix)) return null

  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null

    const handle = fs.openSync(file, 'r')
    try {
      const length = Math.min(stat.size, MAX_ARTIFACT_BYTES)
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, 0)
      return {
        path: relativePath,
        content: buffer.toString('utf-8'),
        truncated: stat.size > MAX_ARTIFACT_BYTES,
        size: stat.size,
      }
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return null
  }
}
