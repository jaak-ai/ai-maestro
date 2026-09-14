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
} from 'lucide-react'
import type { VoloBoard, VoloTask } from '@/lib/volo/client'
import AssignTaskDialog from '@/components/volo/AssignTaskDialog'

interface Status {
  connected: boolean
  expired?: boolean
  scope?: string
  redirectUri?: string
}

interface Column {
  id: string
  name: string
  order?: number
  tasks: VoloTask[]
}

/** Group tasks under their column — Volo's columns carry no task array. */
function groupByColumn(board: VoloBoard): Column[] {
  const columns = [...(board.columns || [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  )
  const byColumn = new Map<string, VoloTask[]>()
  for (const task of board.tasks || []) {
    if (!task.columnId) continue
    const list = byColumn.get(task.columnId)
    if (list) list.push(task)
    else byColumn.set(task.columnId, [task])
  }
  return columns.map((c) => ({
    ...c,
    tasks: (byColumn.get(c.id) || []).sort(
      (a, b) => (a.taskNumber ?? 0) - (b.taskNumber ?? 0)
    ),
  }))
}

const PRIORITY_STYLES: Record<string, string> = {
  urgent: 'bg-red-500/15 text-red-300 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  medium: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  low: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
}

export default function VoloPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [boards, setBoards] = useState<VoloBoard[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [board, setBoard] = useState<VoloBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingBoard, setLoadingBoard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [assigning, setAssigning] = useState<VoloTask | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/volo/status')
      setStatus(await res.json())
    } catch {
      setStatus({ connected: false })
    }
  }, [])

  const loadBoards = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/volo/boards')
      if (res.status === 409) {
        setStatus({ connected: false })
        return
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudieron leer los boards')
      setBoards(data.boards || [])
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      await loadStatus()
      setLoading(false)
    })()
  }, [loadStatus])

  useEffect(() => {
    if (status?.connected) void loadBoards()
  }, [status?.connected, loadBoards])

  useEffect(() => {
    if (!selected) return
    setLoadingBoard(true)
    setError(null)
    fetch(`/api/volo/boards/${encodeURIComponent(selected)}`)
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'No se pudo leer el board')
        setBoard(data.board)
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoadingBoard(false))
  }, [selected])

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-300 flex items-center justify-center">
        <RefreshCw className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <Link
          href="/"
          className="text-gray-400 hover:text-gray-200 flex items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          Agentes
        </Link>
        <h1 className="text-lg font-medium flex items-center gap-2">
          <ListTodo className="w-5 h-5 text-teal-400" />
          Volo
        </h1>
        {status?.connected && (
          <button
            onClick={() => {
              void loadBoards()
              if (selected) setSelected(selected)
            }}
            className="ml-auto text-sm text-gray-400 hover:text-gray-200 flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Actualizar
          </button>
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

            <div className="mb-6 flex flex-wrap gap-2">
              {boards.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setSelected(b.prefix)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    selected === b.prefix
                      ? 'border-teal-500 bg-teal-500/15 text-teal-200'
                      : 'border-gray-800 bg-gray-900 text-gray-400 hover:border-gray-700 hover:text-gray-200'
                  }`}
                >
                  <span className="font-mono text-xs text-gray-500">
                    {b.prefix}
                  </span>{' '}
                  {b.name}
                </button>
              ))}
            </div>

            {loadingBoard && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Cargando board...
              </div>
            )}

            {!loadingBoard && !selected && (
              <p className="text-sm text-gray-500">
                Elige un board para ver sus tareas.
              </p>
            )}

            {!loadingBoard && board && (
              <div className="flex gap-4 overflow-x-auto pb-4">
                {groupByColumn(board).map((column) => (
                  <section
                    key={column.id}
                    className="w-72 shrink-0 rounded-lg border border-gray-800 bg-gray-900/50"
                  >
                    <h2 className="flex items-center justify-between border-b border-gray-800 px-3 py-2 text-sm font-medium">
                      {column.name}
                      <span className="text-xs text-gray-600">
                        {column.tasks.length}
                      </span>
                    </h2>
                    <div className="space-y-2 p-2">
                      {column.tasks.length === 0 && (
                        <p className="px-1 py-2 text-xs text-gray-600">Vacío</p>
                      )}
                      {column.tasks.map((task) => (
                        <article
                          key={task.id}
                          className="group rounded border border-gray-800 bg-gray-900 p-2.5 text-sm hover:border-gray-700"
                        >
                          <div className="mb-1 flex items-center gap-2">
                            <span className="font-mono text-xs text-teal-500">
                              {task.taskCode}
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
                          </div>
                          <p className="mb-2 leading-snug text-gray-300">
                            {task.title}
                          </p>
                          <button
                            onClick={() => setAssigning(task)}
                            className="flex items-center gap-1.5 text-xs text-gray-500 opacity-0 transition-opacity hover:text-teal-400 group-hover:opacity-100"
                          >
                            <Send className="h-3 w-3" />
                            Asignar a un agente
                          </button>
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {assigning && (
        <AssignTaskDialog
          task={assigning}
          onClose={() => setAssigning(null)}
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
 * a browser on another machine — the case that a CLI loopback redirect cannot
 * serve.
 */
function ConnectPrompt({ status }: { status: Status | null }) {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-gray-800 bg-gray-900/50 p-8 text-center">
      <ListTodo className="mx-auto mb-4 h-10 w-10 text-gray-700" />
      <h2 className="mb-2 text-lg font-medium">Volo no está conectado</h2>
      <p className="mb-6 text-sm text-gray-500">
        {status?.expired
          ? 'La sesión con Volo caducó y no se pudo renovar. Vuelve a conectar.'
          : 'Conecta tu cuenta de Volo para ver los boards y asignar tareas a los agentes.'}
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
