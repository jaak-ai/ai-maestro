import { NextRequest, NextResponse } from 'next/server'
import { getTask, moveTask, VoloNotConnectedError } from '@/lib/volo/client'
import { sendFromUI } from '@/lib/message-send'
import { getAgent } from '@/lib/agent-registry'
import { recordAssignment } from '@/lib/volo/assignments'
import { getCrossBoardKanban } from '@/lib/volo/client'

/**
 * POST /api/volo/assign
 *
 * Deliver a Volo task to an agent's AMP inbox.
 *
 * Delivery is store-and-forward, so assigning to an agent that is offline
 * queues the task rather than failing; the agent picks it up when it wakes.
 */
export const dynamic = 'force-dynamic'

interface AssignBody {
  taskCode: string
  agentId: string
  note?: string
  /** Column to move the task to in Volo, after delivery succeeds. */
  moveToColumnId?: string
  /**
   * Advance the task to the board's in-progress column without naming it.
   * Column ids differ per board, so the caller usually cannot know one.
   */
  advanceInVolo?: boolean
}

export async function POST(request: NextRequest) {
  let body: AssignBody
  try {
    body = (await request.json()) as AssignBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!body.taskCode || !body.agentId) {
    return NextResponse.json(
      { error: 'taskCode and agentId are required' },
      { status: 400 }
    )
  }

  const agent = getAgent(body.agentId)
  if (!agent) {
    return NextResponse.json({ error: 'agent_not_found' }, { status: 404 })
  }

  let detail
  try {
    detail = await getTask(body.taskCode)
  } catch (err) {
    if (err instanceof VoloNotConnectedError) {
      return NextResponse.json({ error: 'not_connected' }, { status: 409 })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }

  const task = detail?.task
  if (!task) {
    return NextResponse.json({ error: 'task_not_found' }, { status: 404 })
  }

  const title = task.title || body.taskCode
  const sections = [
    'Tarea asignada desde Volo.',
    '',
    `ID:     ${body.taskCode}`,
    `Título: ${title}`,
    '',
    task.description || '',
  ]

  if (body.note?.trim()) {
    sections.push('', '--- Nota de quien asigna ---', body.note.trim())
  }

  // The working agreement travels with the task on purpose: an agent handed
  // only a title tends to invent its own process — filing subtasks as new Volo
  // tasks, or closing work outright instead of leaving it for review.
  sections.push(
    '',
    '--- Cómo trabajarla ---',
    '- Volo es la fuente de verdad: consulta el detalle con el MCP jaak-volo si necesitas más contexto.',
    '- Si la tarea tiene subtareas, NO crees tareas nuevas en Volo: regístralas como checklist en pendientes.md en la raíz del repo, en la rama de trabajo de esta tarea.',
    `- Al terminar todos los items, márcalos, commitea y mueve ${body.taskCode} a Review (no a Done; Done lo valida una persona).`
  )

  let outcome
  try {
    outcome = await sendFromUI({
      from: 'volo',
      to: agent.id,
      subject: `[${body.taskCode}] ${title}`,
      content: { type: 'request', message: sections.join('\n') },
      priority: 'normal',
    })
  } catch (err) {
    return NextResponse.json(
      { error: `delivery_failed: ${(err as Error).message}` },
      { status: 502 }
    )
  }

  // Advancing in Volo happens only after delivery succeeded. Marking a task in
  // progress that was never delivered leaves Volo claiming work is underway
  // when no agent ever received it.
  let moved = false
  let moveError: string | undefined
  const boardId = detail?.board?.id

  let columnId = body.moveToColumnId
  if (!columnId && body.advanceInVolo && boardId) {
    // Resolve the board's in-progress column. Boards name it differently
    // ("In Progress", "En curso", "En Ejecución"), so match on the normalised
    // type Volo already computes rather than on the label.
    try {
      const kanban = await getCrossBoardKanban({
        mine: false,
        limit: 200,
        boardIds: [boardId],
      })
      const sample = kanban.columns
        .flatMap((c) => c.tasks)
        .find((t) => t.boardId === boardId && t.columnType === 'in_progress')
      columnId = sample?.columnId
    } catch {
      /* fall through to the no-column case below */
    }
  }

  if (columnId && boardId) {
    try {
      await moveTask(boardId, task.id, columnId)
      moved = true
    } catch (err) {
      moveError = (err as Error).message
    }
  } else if (body.advanceInVolo) {
    moveError = 'No se encontró una columna "en curso" en el board'
  }

  // Recorded after delivery, so the queue never shows a task as being with an
  // agent that never received it.
  recordAssignment({
    taskCode: body.taskCode,
    taskTitle: title,
    boardPrefix: detail?.board?.prefix || '',
    boardName: detail?.board?.name || '',
    agentId: agent.id,
    agentName: agent.label || agent.name,
    messageId: outcome.message.id,
    assignedAt: new Date().toISOString(),
    deferred: outcome.deferred === true,
    state: 'delivered',
    movedInVolo: moved,
  })

  return NextResponse.json({
    delivered: true,
    messageId: outcome.message.id,
    notified: outcome.notified,
    deferred: outcome.deferred === true,
    moved,
    moveError,
  })
}
