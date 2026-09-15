'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  X,
  RefreshCw,
  FileText,
  Activity,
  PauseCircle,
  CheckCircle2,
  MessageSquare,
  User,
} from 'lucide-react'

interface RunEvent {
  ts: string
  fase: string
  tipo: 'fase_inicio' | 'fase_fin' | 'nota' | 'intervencion_humana'
  mensaje: string
  datos?: Record<string, unknown>
  actor?: string
}

interface Run {
  taskCode: string
  workspacePath: string
  currentPhase: string | null
  phaseLabel: string | null
  awaitingHuman: boolean
  currentMessage: string | null
  startedAt: string | null
  lastEventAt: string | null
  phasesCompleted: string[]
  eventCount: number
  recent: RunEvent[]
}

interface Artifact {
  path: string
  name: string
  category: string
  size: number
  modifiedAt: string
}

const EVENT_ICONS = {
  fase_inicio: Activity,
  fase_fin: CheckCircle2,
  nota: MessageSquare,
  intervencion_humana: User,
} as const

function time(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('es', {
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

export default function RunPanel({
  taskCode,
  agentId,
  onClose,
}: {
  taskCode: string
  /** Lets the panel say WHY there is no run, instead of only that there isn't. */
  agentId?: string
  onClose: () => void
}) {
  const [agentOnline, setAgentOnline] = useState<boolean | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [noRun, setNoRun] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/volo/runs/${encodeURIComponent(taskCode)}`)
      if (res.status === 404) {
        setNoRun(true)
        return
      }
      setRun(await res.json())

      const list = await fetch(
        `/api/volo/runs/${encodeURIComponent(taskCode)}/artifacts`
      )
      const data = await list.json()
      setArtifacts(data.artifacts || [])
    } catch {
      setNoRun(true)
    } finally {
      setLoading(false)
    }
  }, [taskCode])

  // A missing run has three very different causes — the agent is off, the
  // orchestrator skill is not installed, or the run simply has not begun. Only
  // the first is visible from here, and it is the most common.
  useEffect(() => {
    if (!agentId) return
    fetch('/api/agents')
      .then((r) => r.json())
      .then((d) => {
        const found = (d.agents || []).find(
          (a: { id: string }) => a.id === agentId
        )
        setAgentOnline(
          !!found?.sessions?.some(
            (s: { status?: string }) => s.status === 'online'
          )
        )
      })
      .catch(() => setAgentOnline(null))
  }, [agentId])

  useEffect(() => {
    void load()
    // The orchestrator writes as it works, so a run in flight changes under
    // the panel. Polling beats a stale view; SSE would be better but needs the
    // sidecar this replaces.
    const timer = setInterval(() => void load(), 10000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openArtifact = async (artifactPath: string) => {
    if (open === artifactPath) {
      setOpen(null)
      setContent(null)
      return
    }
    setOpen(artifactPath)
    setContent(null)
    try {
      const res = await fetch(
        `/api/volo/runs/${encodeURIComponent(taskCode)}/artifacts?path=${encodeURIComponent(artifactPath)}`
      )
      const data = await res.json()
      setContent(
        res.ok
          ? data.content + (data.truncated ? '\n\n[…recortado]' : '')
          : 'No se pudo leer el artefacto.'
      )
    } catch {
      setContent('No se pudo leer el artefacto.')
    }
  }

  const byCategory = artifacts.reduce<Record<string, Artifact[]>>((acc, a) => {
    ;(acc[a.category] ||= []).push(a)
    return acc
  }, {})

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-2xl flex-col border-l border-gray-800 bg-gray-950"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-gray-800 px-5 py-3">
          <span className="font-mono text-sm text-teal-500">{taskCode}</span>
          <button
            onClick={() => void load()}
            className="text-gray-500 hover:text-gray-300"
            title="Actualizar"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            className="ml-auto text-gray-500 hover:text-gray-300"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Cargando...
            </div>
          )}

          {noRun && (
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-6 text-center">
              <p className="text-sm text-gray-400">
                No hay corrida del orquestador para esta tarea.
              </p>
              {agentOnline === false ? (
                <>
                  <p className="mt-2 text-xs text-amber-300">
                    El agente está apagado. La tarea llegó a su buzón, pero no
                    hay ningún proceso que la lea.
                  </p>
                  <p className="mt-1 text-xs text-gray-600">
                    Arranca su sesión y la recogerá al despertar.
                  </p>
                </>
              ) : (
                <p className="mt-2 text-xs text-gray-600">
                  Aparecerá aquí cuando el agente arranque
                  task-orchestrator-ligo-skill. Si el agente está vivo y esto
                  no cambia, puede que no tenga el skill instalado.
                </p>
              )}
            </div>
          )}

          {run && (
            <>
              <section
                className={`mb-5 rounded-lg border p-4 ${
                  run.awaitingHuman
                    ? 'border-amber-500/30 bg-amber-500/10'
                    : 'border-blue-500/20 bg-blue-500/5'
                }`}
              >
                <div className="flex items-center gap-2">
                  {run.awaitingHuman ? (
                    <PauseCircle className="h-4 w-4 text-amber-400" />
                  ) : (
                    <Activity className="h-4 w-4 animate-pulse text-blue-400" />
                  )}
                  <h2
                    className={`text-sm font-medium ${
                      run.awaitingHuman ? 'text-amber-200' : 'text-blue-200'
                    }`}
                  >
                    {run.phaseLabel || 'Sin fase activa'}
                  </h2>
                  <span className="ml-auto text-xs text-gray-600">
                    {run.phasesCompleted.length} fases completadas
                  </span>
                </div>
                {run.currentMessage && (
                  <p className="mt-1.5 text-xs text-gray-400">
                    {run.currentMessage}
                  </p>
                )}
                {run.awaitingHuman && (
                  <p className="mt-2 text-xs text-amber-300/80">
                    La corrida está detenida esperando tu respuesta. No avanzará
                    sola.
                  </p>
                )}
              </section>

              <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-600">
                Últimos eventos
              </h3>
              <ol className="mb-6 space-y-1.5">
                {run.recent.map((event, i) => {
                  const Icon = EVENT_ICONS[event.tipo] || MessageSquare
                  return (
                    <li
                      key={`${event.ts}-${i}`}
                      className="flex items-start gap-2 text-xs"
                    >
                      <Icon
                        className={`mt-0.5 h-3 w-3 shrink-0 ${
                          event.tipo === 'intervencion_humana'
                            ? 'text-amber-400'
                            : event.tipo === 'fase_fin'
                              ? 'text-green-500'
                              : 'text-gray-600'
                        }`}
                      />
                      <span className="shrink-0 font-mono text-gray-600">
                        {time(event.ts)}
                      </span>
                      <span className="text-gray-400">
                        {event.mensaje}
                        {event.actor && (
                          <span className="text-amber-400/70"> · {event.actor}</span>
                        )}
                      </span>
                    </li>
                  )
                })}
                {run.recent.length === 0 && (
                  <li className="text-xs text-gray-600">Sin eventos todavía.</li>
                )}
              </ol>

              <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-600">
                Artefactos
              </h3>
              {artifacts.length === 0 && (
                <p className="text-xs text-gray-600">
                  La corrida aún no ha escrito ninguno.
                </p>
              )}
              {Object.entries(byCategory).map(([category, files]) => (
                <div key={category} className="mb-3">
                  <p className="mb-1 text-[11px] text-gray-600">{category}</p>
                  <div className="space-y-1">
                    {files.map((file) => (
                      <div key={file.path}>
                        <button
                          onClick={() => void openArtifact(file.path)}
                          className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors ${
                            open === file.path
                              ? 'border-teal-600 bg-teal-500/10 text-teal-200'
                              : 'border-gray-800 text-gray-400 hover:border-gray-700'
                          }`}
                        >
                          <FileText className="h-3 w-3 shrink-0" />
                          {file.name}
                          <span className="ml-auto text-gray-600">
                            {Math.round(file.size / 102.4) / 10} KB
                          </span>
                        </button>
                        {open === file.path && (
                          <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-3 text-[11px] leading-relaxed text-gray-400">
                            {content ?? 'Cargando...'}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <p className="mt-6 break-all text-[10px] text-gray-700">
                {run.workspacePath}
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
