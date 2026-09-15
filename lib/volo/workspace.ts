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

/** Locate a task's workspace, or null when no run has been started. */
export function findWorkspace(taskCode: string): string | null {
  // Task codes reach the filesystem, so reject anything that is not a plain
  // code rather than letting `../` walk out of the workspace root.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(taskCode)) return null

  for (const root of workspaceRoots()) {
    const candidate = path.join(root, taskCode)
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
