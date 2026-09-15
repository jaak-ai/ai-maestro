'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  ListTodo,
  Link2,
  RefreshCw,
  AlertTriangle,
  Send,
  Clock,
  Bot,
  CheckCircle2,
  Inbox,
  Search,
  X,
  Activity,
  PauseCircle,
} from 'lucide-react'
import { priorityCode, priorityRank } from '@/lib/volo/priority'
import type { CrossBoardTask } from '@/lib/volo/client'
import type { Assignment } from '@/lib/volo/assignments'
import AssignTaskDialog from '@/components/volo/AssignTaskDialog'
import RunPanel from '@/components/volo/RunPanel'

interface Status {
  connected: boolean
  expired?: boolean
  redirectUri?: string
}

/** Live state of a task-orchestrator run, when one exists. */
interface Run {
  phase: string | null
  phaseLabel: string | null
  awaitingHuman: boolean
  message: string | null
  lastEventAt: string | null
  phasesCompleted: number
}

type AssignmentWithRun = Assignment & { run?: Run | null }

interface Queue {
  unassigned: CrossBoardTask[]
  withAgent: AssignmentWithRun[]
  answered: AssignmentWithRun[]
  boards: Array<{ id: string; name: string; prefix: string }>
  truncated?: number
  voloError?: string | null
}

const PRIORITY_STYLES: Record<string, string> = {
  P0: 'bg-red-500/20 text-red-300 border-red-500/40 font-semibold',
  P1: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  P2: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  P3: 'bg-gray-500/10 text-gray-500 border-gray-700',
}

const PRIORITIES = [
  { value: 'critical', label: 'P0 · Critical' },
  { value: 'high', label: 'P1 · High' },
  { value: 'medium', label: 'P2 · Medium' },
  { value: 'low', label: 'P3 · Low' },
]

/**
 * Volo normalises every column to three types, which hides the step a task is
 * actually at: `Review` and `Blocked` both arrive as `in_progress`, so a
 * blocked task looks identical to one being worked on. The real column name is
 * shown on the card for exactly that reason.
 */
const STEP_STYLES: Record<string, string> = {
  Blocked: 'bg-red-500/15 text-red-300',
  Bloqueado: 'bg-red-500/15 text-red-300',
  Review: 'bg-purple-500/15 text-purple-300',
  'En Revisión': 'bg-purple-500/15 text-purple-300',
}

/** Age is only worth showing once a task has clearly stalled. */
function ageLabel(days?: number): string | null {
  if (days == null || days < 7) return null
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}m`
}

function since(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (mins < 1) return 'ahora'
  if (mins < 60) return `hace ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `hace ${hours}h`
  return `hace ${Math.round(hours / 24)}d`
}

export default function VoloPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [queue, setQueue] = useState<Queue | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [assigning, setAssigning] = useState<CrossBoardTask | null>(null)
  const [viewingRun, setViewingRun] = useState<AssignmentWithRun | null>(null)

  // Filters
  const [mine, setMine] = useState(true)
  const [board, setBoard] = useState<string | null>(null)
  const [priority, setPriority] = useState<string | null>(null)
  const [agent, setAgent] = useState<string | null>(null)
  const [stalled, setStalled] = useState(false)
  const [search, setSearch] = useState('')

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await (await fetch('/api/volo/status')).json())
    } catch {
      setStatus({ connected: false })
    }
  }, [])

  const loadQueue = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(`/api/volo/queue?mine=${mine}`)
      if (res.status === 409) {
        setStatus({ connected: false })
        return
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo leer la cola')
      setQueue(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRefreshing(false)
    }
  }, [mine])

  useEffect(() => {
    void loadStatus().then(() => setLoading(false))
  }, [loadStatus])

  useEffect(() => {
    if (status?.connected) void loadQueue()
  }, [status?.connected, loadQueue])

  const agentsInQueue = useMemo(() => {
    const names = new Set<string>()
    for (const a of [...(queue?.withAgent || []), ...(queue?.answered || [])]) {
      names.add(a.agentName)
    }
    return [...names].sort()
  }, [queue])

  const term = search.trim().toLowerCase()

  // P0 first, always. Within a priority, the stalest task leads: those are the
  // ones worth delegating.
  const byPriorityThenAge = (a: CrossBoardTask, b: CrossBoardTask) => {
    const rank = priorityRank(a.priority) - priorityRank(b.priority)
    return rank !== 0 ? rank : (b.ageDays ?? 0) - (a.ageDays ?? 0)
  }

  const filteredTasks = (queue?.unassigned || []).filter((t) => {
    if (board && t.boardPrefix !== board) return false
    if (priority && t.priority !== priority) return false
    if (stalled && (t.ageDays ?? 0) < 7) return false
    // Filtering by agent is asking "what is X working on", and nothing in this
    // column has been delegated yet — so it legitimately empties.
    if (agent) return false
    if (term && !`${t.taskCode} ${t.title}`.toLowerCase().includes(term)) {
      return false
    }
    return true
  }).sort(byPriorityThenAge)

  const filterAssignments = (list: AssignmentWithRun[]) =>
    list.filter((a) => {
      if (board && a.boardPrefix !== board) return false
      if (agent && a.agentName !== agent) return false
      if (priority && a.priority !== priority) return false
      if (term && !`${a.taskCode} ${a.taskTitle}`.toLowerCase().includes(term)) {
        return false
      }
      return true
    })

  // Same rule everywhere: P0 at the top of every column.
  const byAssignmentPriority = (a: AssignmentWithRun, b: AssignmentWithRun) =>
    priorityRank(a.priority) - priorityRank(b.priority)

  const withAgent = filterAssignments(queue?.withAgent || []).sort(
    byAssignmentPriority
  )
  const answered = filterAssignments(queue?.answered || []).sort(
    byAssignmentPriority
  )

  const anyFilter = board || priority || agent || stalled || term

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-300">
        <RefreshCw className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 text-gray-200">
      <header className="flex flex-wrap items-center gap-4 border-b border-gray-800 px-6 py-3">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Agentes
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <ListTodo className="h-5 w-5 text-teal-400" />
          Cola de desarrollo
        </h1>
        {status?.connected && (
          <button
            onClick={() => void loadQueue()}
            disabled={refreshing}
            className="ml-auto flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
            />
            Actualizar
          </button>
        )}
      </header>

      {!status?.connected ? (
        <main className="px-6 py-6">
          <ConnectPrompt status={status} />
        </main>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-800 px-6 py-2.5 text-xs">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-600" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar..."
                className="w-44 rounded border border-gray-800 bg-gray-900 py-1 pl-7 pr-2 text-gray-200 placeholder-gray-600 focus:border-teal-600 focus:outline-none"
              />
            </div>

            <Select
              value={board}
              onChange={setBoard}
              placeholder="Proyecto"
              options={(queue?.boards || []).map((b) => ({
                value: b.prefix,
                label: `${b.prefix} · ${b.name}`,
              }))}
            />
            <Select
              value={priority}
              onChange={setPriority}
              placeholder="Prioridad"
              options={PRIORITIES}
            />
            <Select
              value={agent}
              onChange={setAgent}
              placeholder="Agente"
              options={agentsInQueue.map((a) => ({ value: a, label: a }))}
            />

            <button
              onClick={() => setStalled(!stalled)}
              className={`rounded border px-2 py-1 transition-colors ${
                stalled
                  ? 'border-orange-500 bg-orange-500/15 text-orange-300'
                  : 'border-gray-800 text-gray-500 hover:text-gray-300'
              }`}
              title="Sin cambios desde hace más de una semana"
            >
              Estancadas
            </button>
            <label className="flex cursor-pointer items-center gap-1.5 text-gray-400">
              <input
                type="checkbox"
                checked={mine}
                onChange={(e) => setMine(e.target.checked)}
                className="accent-teal-600"
              />
              Solo mías
            </label>

            {anyFilter && (
              <button
                onClick={() => {
                  setBoard(null)
                  setPriority(null)
                  setAgent(null)
                  setStalled(false)
                  setSearch('')
                }}
                className="flex items-center gap-1 text-gray-500 hover:text-gray-300"
              >
                <X className="h-3 w-3" />
                Limpiar
              </button>
            )}

            {!!queue?.truncated && (
              <span className="ml-auto text-gray-600">
                {queue.truncated} tareas más sin traer de Volo
              </span>
            )}
          </div>

          <main className="flex-1 px-6 py-4">
            {(error || queue?.voloError) && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error || queue?.voloError}</span>
              </div>
            )}

            {/* Three equal columns. A grid rather than fixed widths so the
                space divides evenly at any viewport instead of scrolling. */}
            <div className="grid h-full grid-cols-1 gap-4 lg:grid-cols-3">
              <Column
                icon={<Inbox className="h-4 w-4 text-gray-500" />}
                title="En Volo"
                subtitle="sin asignar a ningún agente"
                count={filteredTasks.length}
              >
                {filteredTasks.map((task) => (
                  <article
                    key={task.taskId}
                    className="group rounded border border-gray-800 bg-gray-900 p-2.5 text-sm hover:border-gray-700"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs text-teal-500">
                        {task.taskCode}
                      </span>
                      <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                        {task.boardPrefix}
                      </span>
                      {priorityCode(task.priority) && (
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] ${
                            PRIORITY_STYLES[priorityCode(task.priority)!] ||
                            PRIORITY_STYLES.P3
                          }`}
                        >
                          {priorityCode(task.priority)}
                        </span>
                      )}
                      {/* The step, not the normalised type: Volo reports
                          Review and Blocked both as in_progress. */}
                      {task.columnName && (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            STEP_STYLES[task.columnName] ||
                            'bg-gray-800 text-gray-500'
                          }`}
                        >
                          {task.columnName}
                        </span>
                      )}
                      {ageLabel(task.ageDays) && (
                        <span
                          className="ml-auto flex items-center gap-0.5 text-[10px] text-gray-600"
                          title={`Sin cambios desde hace ${task.ageDays} días`}
                        >
                          <Clock className="h-2.5 w-2.5" />
                          {ageLabel(task.ageDays)}
                        </span>
                      )}
                    </div>
                    <p className="mb-2 leading-snug text-gray-300">
                      {task.title}
                    </p>
                    <button
                      onClick={() => setAssigning(task)}
                      className="flex items-center gap-1.5 text-xs text-gray-500 opacity-0 transition-opacity hover:text-teal-400 group-hover:opacity-100"
                    >
                      <Send className="h-3 w-3" />
                      Pasar a un agente
                    </button>
                  </article>
                ))}
              </Column>

              <Column
                icon={<Bot className="h-4 w-4 text-blue-400" />}
                title="Con agente"
                subtitle="en curso — la fase viene del orquestador"
                count={withAgent.length}
              >
                {withAgent.map((a) => (
                  <AssignmentCard
                    key={a.taskCode}
                    assignment={a}
                    onOpenRun={setViewingRun}
                  />
                ))}
              </Column>

              <Column
                icon={<CheckCircle2 className="h-4 w-4 text-green-400" />}
                title="Para revisar"
                subtitle="el agente contestó — léelo, no implica que esté hecho"
                count={answered.length}
              >
                {answered.map((a) => (
                  <AssignmentCard
                    key={a.taskCode}
                    assignment={a}
                    showAnswer
                    onOpenRun={setViewingRun}
                  />
                ))}
              </Column>
            </div>
          </main>
        </>
      )}

      {viewingRun && (
        <RunPanel
          taskCode={viewingRun.taskCode}
          agentId={viewingRun.agentId}
          onClose={() => setViewingRun(null)}
        />
      )}

      {assigning && (
        <AssignTaskDialog
          task={assigning}
          onClose={() => setAssigning(null)}
          onAssigned={() => void loadQueue()}
        />
      )}
    </div>
  )
}

function Column({
  icon,
  title,
  subtitle,
  count,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-gray-800 bg-gray-900/40">
      <header className="border-b border-gray-800 px-3 py-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
          <span className="ml-auto text-xs text-gray-600">{count}</span>
        </h2>
        <p className="mt-0.5 text-[11px] text-gray-600">{subtitle}</p>
      </header>
      <div className="max-h-[calc(100vh-15rem)] space-y-2 overflow-y-auto p-2">
        {count === 0 ? (
          <p className="px-1 py-3 text-xs text-gray-600">Vacío</p>
        ) : (
          children
        )}
      </div>
    </section>
  )
}

function AssignmentCard({
  assignment,
  showAnswer,
  onOpenRun,
}: {
  assignment: AssignmentWithRun
  showAnswer?: boolean
  onOpenRun?: (assignment: AssignmentWithRun) => void
}) {
  const run = assignment.run
  return (
    <article
      onClick={() => onOpenRun?.(assignment)}
      className="cursor-pointer rounded border border-gray-800 bg-gray-900 p-2.5 text-sm transition-colors hover:border-gray-700"
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-teal-500">
          {assignment.taskCode}
        </span>
        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
          {assignment.boardPrefix}
        </span>
        {priorityCode(assignment.priority) && (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              PRIORITY_STYLES[priorityCode(assignment.priority)!] ||
              PRIORITY_STYLES.P3
            }`}
          >
            {priorityCode(assignment.priority)}
          </span>
        )}
        <span className="ml-auto text-[10px] text-gray-600">
          {since(assignment.answeredAt || assignment.assignedAt)}
        </span>
      </div>
      <p className="mb-2 leading-snug text-gray-300">{assignment.taskTitle}</p>
      {/* The phase is the answer to "what step is this at". Without it, a run
          exploring the code and one parked on a human checkpoint look the
          same. */}
      {run?.phaseLabel && (
        <div
          className={`mb-2 flex items-center gap-1.5 rounded px-2 py-1 text-[11px] ${
            run.awaitingHuman
              ? 'bg-amber-500/15 text-amber-300'
              : 'bg-blue-500/10 text-blue-300'
          }`}
          title={run.message || undefined}
        >
          {run.awaitingHuman ? (
            <PauseCircle className="h-3 w-3 shrink-0" />
          ) : (
            <Activity className="h-3 w-3 shrink-0 animate-pulse" />
          )}
          <span className="truncate">{run.phaseLabel}</span>
          {run.phasesCompleted > 0 && (
            <span className="ml-auto shrink-0 text-gray-600">
              {run.phasesCompleted} fases
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
        <Bot className="h-3 w-3" />
        {assignment.agentName}
        {/* Queued delivery is the designed behaviour, not a failure — but an
            operator who is not told will read the silence as a broken agent. */}
        {assignment.deferred && !assignment.answeredAt && (
          <span className="text-gray-600">· estaba apagado</span>
        )}
        {assignment.movedInVolo && (
          <span className="text-gray-600">· movida en Volo</span>
        )}
      </div>
      {showAnswer && assignment.answer && (
        <p className="mt-2 line-clamp-4 rounded bg-gray-950/60 p-2 text-[11px] leading-snug text-gray-400">
          {assignment.answer}
        </p>
      )}
    </article>
  )
}

function Select({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string | null
  onChange: (v: string | null) => void
  placeholder: string
  options: Array<{ value: string; label: string }>
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className={`rounded border bg-gray-900 px-2 py-1 focus:outline-none ${
        value
          ? 'border-teal-600 text-teal-200'
          : 'border-gray-800 text-gray-500'
      }`}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/**
 * Shown when Volo is not connected.
 *
 * A plain link to the server-side flow rather than a fetch: the redirect lands
 * on this same origin, which is what makes "Connect" work from a browser on
 * another machine — the case a CLI loopback redirect cannot serve.
 */
function ConnectPrompt({ status }: { status: Status | null }) {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-gray-800 bg-gray-900/50 p-8 text-center">
      <ListTodo className="mx-auto mb-4 h-10 w-10 text-gray-700" />
      <h2 className="mb-2 text-lg font-medium">Volo no está conectado</h2>
      <p className="mb-6 text-sm text-gray-500">
        {status?.expired
          ? 'La sesión con Volo caducó y no se pudo renovar. Vuelve a conectar.'
          : 'Conecta tu cuenta de Volo para ver tu trabajo y pasar tareas a los agentes.'}
      </p>
      <a
        href="/api/volo/auth/start?returnTo=/volo"
        className="inline-flex items-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm text-white transition-colors hover:bg-teal-700"
      >
        <Link2 className="h-4 w-4" />
        Conectar con Volo
      </a>
      {status?.redirectUri && (
        <p className="mt-6 text-xs text-gray-600">
          Volo devolverá el navegador a{' '}
          <code className="text-gray-500">{status.redirectUri}</code>
        </p>
      )}
    </div>
  )
}
