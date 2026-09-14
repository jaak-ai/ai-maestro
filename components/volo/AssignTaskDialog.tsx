'use client'

import { useState, useEffect } from 'react'
import { X, Send, AlertTriangle, Check } from 'lucide-react'
import type { VoloTask } from '@/lib/volo/client'

interface Agent {
  id: string
  name: string
  label?: string
  taskDescription?: string
}

interface Props {
  task: VoloTask
  onClose: () => void
}

interface Result {
  delivered: boolean
  deferred?: boolean
  moved?: boolean
  moveError?: string
}

export default function AssignTaskDialog({ task, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState('')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    fetch('/api/agents')
      .then((res) => res.json())
      .then((data) => setAgents(data.agents || []))
      .catch(() => setAgents([]))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const assign = async () => {
    if (!agentId) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/volo/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskCode: task.taskCode,
          agentId,
          note: note.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'No se pudo asignar')
      setResult(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-teal-500">{task.taskCode}</p>
            <h2 className="text-sm leading-snug text-gray-200">{task.title}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {result ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-300">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Entregada.
                {/* Queued delivery is the designed behaviour, not a failure —
                    but saying nothing would leave the operator wondering why
                    the agent has not reacted. */}
                {result.deferred
                  ? ' El agente está apagado; la recibirá al despertar.'
                  : ' El agente ha sido avisado.'}
              </span>
            </div>
            <button
              onClick={onClose}
              className="w-full rounded-lg bg-gray-800 px-4 py-2 text-sm hover:bg-gray-700"
            >
              Cerrar
            </button>
          </div>
        ) : (
          <>
            <label className="mb-1.5 block text-xs text-gray-500">Agente</label>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="mb-4 w-full rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-200 focus:border-teal-600 focus:outline-none"
            >
              <option value="">Elige un agente...</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label || a.name}
                </option>
              ))}
            </select>

            {agents.length === 0 && (
              <p className="-mt-2 mb-4 text-xs text-gray-600">
                No hay agentes registrados.
              </p>
            )}

            <label className="mb-1.5 block text-xs text-gray-500">
              Nota (opcional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Por dónde empezar, restricciones, contexto..."
              className="mb-4 w-full resize-none rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-teal-600 focus:outline-none"
            />

            {error && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              onClick={assign}
              disabled={!agentId || sending}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 py-2 text-sm text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-600"
            >
              <Send className="h-3.5 w-3.5" />
              {sending ? 'Enviando...' : 'Asignar'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
