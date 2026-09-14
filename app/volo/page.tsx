'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  ListTodo,
  Link2,
  RefreshCw,
  AlertTriangle,
  Send,
  Clock,
} from 'lucide-react'
import type { CrossBoardKanban, CrossBoardTask } from '@/lib/volo/client'
import AssignTaskDialog from '@/components/volo/AssignTaskDialog'

interface Status {
  connected: boolean
  expired?: boolean
  scope?: string
  redirectUri?: string
}

const PRIORITY_STYLES: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-300 border-red-500/30',
  urgent: 'bg-red-500/15 text-red-300 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  medium: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  low: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
}

/**
 * Tasks sitting untouched for a long time are the ones worth handing to an
 * agent, so age is surfaced rather than buried in a detail view.
 */
function ageLabel(days?: number): string | null {
  if (days == null || days < 7) return null
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}m`
}

export default function VoloPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [kanban, setKanban] = useState<CrossBoardKanban | null>(null)
  const [mine, setMine] = useState(true)
  const [includeDone, setIncludeDone] = useState(false)
  const [boardFilter, setBoardFilter] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [assigning, setAssigning] = useState<CrossBoardTask | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/volo/status')
      setStatus(await res.json())
    } catch {
      setStatus({ connected: false })
    }
  }, [])

  const loadWork = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        mine: String(mine),
        includeDone: String(includeDone),
      })
      const res = await fetch(`/api/volo/my-work?${params}`)
      if (res.status === 409) {
        setStatus({ connected: false })
        return
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo leer Volo')
      setKanban(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRefreshing(false)
    }
  }, [mine, includeDone])

  useEffect(() => {
    void loadStatus().then(() => setLoading(false))
  }, [loadStatus])

  useEffect(() => {
    if (status?.connected) void loadWork()
  }, [status?.connected, loadWork])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-300">
        <RefreshCw className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  const columns = (kanban?.columns || []).map((column) => ({
    ...column,
    tasks: boardFilter
      ? column.tasks.filter((t) => t.boardPrefix === boardFilter)
      : column.tasks,
  }))

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200">
      <header className="flex flex-wrap items-center gap-4 border-b border-gray-800 px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Agentes
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <ListTodo className="h-5 w-5 text-teal-400" />
          Mi trabajo
        </h1>

        {status?.connected && (
          <div className="ml-auto flex items-center gap-3 text-sm">
            <label className="flex cursor-pointer items-center gap-1.5 text-gray-400">
              <input
                type="checkbox"
                checked={mine}
                onChange={(e) => setMine(e.target.checked)}
                className="accent-teal-600"
              />
              Solo mías
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-gray-400">
              <input
                type="checkbox"
                checked={includeDone}
                onChange={(e) => setIncludeDone(e.target.checked)}
                className="accent-teal-600"
              />
              Con terminadas
            </label>
            <button
              onClick={() => void loadWork()}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
              />
              Actualizar
            </button>
          </div>
        )}
      </header>

      <main className="px-6 py-6">
        {!status?.connected ? (
          <ConnectPrompt status={status} />
        ) : (
          <>
            {error && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {kanban && (
              <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
                <button
                  onClick={() => setBoardFilter(null)}
                  className={`rounded-full border px-2.5 py-1 transition-colors ${
                    !boardFilter
                      ? 'border-teal-500 bg-teal-500/15 text-teal-200'
                      : 'border-gray-800 text-gray-500 hover:text-gray-300'
                  }`}
                >
                  Todos ({kanban.total})
                </button>
                {kanban.boards.map((b) => (
                  <button
                    key={b.id}
                    onClick={() =>
                      setBoardFilter(boardFilter === b.prefix ? null : b.prefix)
                    }
                    className={`rounded-full border px-2.5 py-1 transition-colors ${
                      boardFilter === b.prefix
                        ? 'border-teal-500 bg-teal-500/15 text-teal-200'
                        : 'border-gray-800 text-gray-500 hover:text-gray-300'
                    }`}
                    title={b.name}
                  >
                    {b.prefix}
                  </button>
                ))}
                {/* Volo caps the result; saying so beats a board that silently
                    omits work the operator knows exists. */}
                {!!kanban.truncated && (
                  <span className="ml-2 text-gray-600">
                    {kanban.truncated} más sin mostrar
                  </span>
                )}
              </div>
            )}

            {refreshing && !kanban && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Cargando...
              </div>
            )}

            <div className="flex gap-4 overflow-x-auto pb-4">
              {columns.map((column) => (
                <section
                  key={column.type}
                  className="w-80 shrink-0 rounded-lg border border-gray-800 bg-gray-900/50"
                >
                  <h2 className="flex items-center justify-between border-b border-gray-800 px-3 py-2 text-sm font-medium">
                    {column.label}
                    <span className="text-xs text-gray-600">
                      {column.tasks.length}
                    </span>
                  </h2>
                  <div className="max-h-[calc(100vh-16rem)] space-y-2 overflow-y-auto p-2">
                    {column.tasks.length === 0 && (
                      <p className="px-1 py-2 text-xs text-gray-600">Vacío</p>
                    )}
                    {column.tasks.map((task) => (
                      <article
                        key={task.taskId}
                        className="group rounded border border-gray-800 bg-gray-900 p-2.5 text-sm hover:border-gray-700"
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-xs text-teal-500">
                            {task.taskCode}
                          </span>
                          {/* Which board a task comes from is essential here:
                              the whole view mixes boards together. */}
                          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                            {task.boardPrefix}
                          </span>
                          {task.priority && (
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${
                                PRIORITY_STYLES[task.priority] ||
                                PRIORITY_STYLES.low
                              }`}
                            >
                              {task.priority}
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
                        <div className="flex items-center justify-between">
                          {!mine && task.assigneeName && (
                            <span className="text-[10px] text-gray-600">
                              {task.assigneeName}
                            </span>
                          )}
                          <button
                            onClick={() => setAssigning(task)}
                            className="ml-auto flex items-center gap-1.5 text-xs text-gray-500 opacity-0 transition-opacity hover:text-teal-400 group-hover:opacity-100"
                          >
                            <Send className="h-3 w-3" />
                            Asignar a un agente
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </main>

      {assigning && (
        <AssignTaskDialog
          task={assigning}
          onClose={() => setAssigning(null)}
          onAssigned={() => void loadWork()}
        />
      )}
    </div>
  )
}

/**
 * Shown when Volo is not connected.
 *
 * The button is a plain link to the server-side flow rather than a fetch: the
 * redirect lands on this same origin, which is what makes "Connect" work from
 * a browser on another machine — the case a CLI loopback redirect cannot serve.
 */
function ConnectPrompt({ status }: { status: Status | null }) {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-gray-800 bg-gray-900/50 p-8 text-center">
      <ListTodo className="mx-auto mb-4 h-10 w-10 text-gray-700" />
      <h2 className="mb-2 text-lg font-medium">Volo no está conectado</h2>
      <p className="mb-6 text-sm text-gray-500">
        {status?.expired
          ? 'La sesión con Volo caducó y no se pudo renovar. Vuelve a conectar.'
          : 'Conecta tu cuenta de Volo para ver tu trabajo y asignar tareas a los agentes.'}
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
