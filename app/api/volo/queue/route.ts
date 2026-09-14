import { NextRequest, NextResponse } from 'next/server'
import {
  getCrossBoardKanban,
  VoloNotConnectedError,
  type CrossBoardTask,
} from '@/lib/volo/client'
import {
  listAssignments,
  markAnswered,
  type Assignment,
} from '@/lib/volo/assignments'
import { findAgentReply, replyText } from '@/lib/volo/agent-reply'

/**
 * GET /api/volo/queue
 *
 * The development queue, in three columns:
 *
 *   unassigned  Volo tasks nobody has handed to an agent
 *   withAgent   delivered to an agent, no reply yet
 *   answered    the agent replied; waiting for a person to check it
 *
 * Only the first column comes from Volo. The other two are AI Maestro's own
 * record of what it delegated — Volo never learns that a task went to an
 * agent, so that fact lives here or nowhere.
 */
export const dynamic = 'force-dynamic'

/**
 * Check the agents' sent boxes for replies to outstanding assignments.
 *
 * Done on read rather than on a timer: the queue is looked at far less often
 * than a poll would run, and a background timer per assignment would keep
 * scanning inboxes for tasks nobody is watching.
 */
async function refreshAnswers(assignments: Assignment[]): Promise<void> {
  const pending = assignments.filter((a) => a.state === 'delivered')

  await Promise.all(
    pending.map(async (assignment) => {
      try {
        const reply = await findAgentReply(
          assignment.agentId,
          assignment.messageId,
          assignment.assignedAt
        )
        if (reply) markAnswered(assignment.taskCode, replyText(reply))
      } catch {
        // An agent whose mailbox cannot be read must not fail the whole queue.
      }
    })
  )
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams

  let tasks: CrossBoardTask[] = []
  let voloError: string | null = null
  let boards: Array<{ id: string; name: string; prefix: string }> = []
  let truncated: number | undefined

  try {
    const kanban = await getCrossBoardKanban({
      mine: params.get('mine') !== 'false',
      includeDone: params.get('includeDone') === 'true',
      limit: 200,
    })
    tasks = kanban.columns.flatMap((c) => c.tasks)
    boards = kanban.boards
    truncated = kanban.truncated
  } catch (err) {
    if (err instanceof VoloNotConnectedError) {
      return NextResponse.json({ error: 'not_connected' }, { status: 409 })
    }
    // Volo being unreachable must not hide what is already with agents: that
    // column is local and still true.
    voloError = (err as Error).message
  }

  const all = listAssignments()
  await refreshAnswers(all)

  const assignments = listAssignments().filter((a) => a.state !== 'cancelled')
  const assignedCodes = new Set(assignments.map((a) => a.taskCode))

  return NextResponse.json({
    unassigned: tasks.filter((t) => !assignedCodes.has(t.taskCode)),
    withAgent: assignments.filter((a) => a.state === 'delivered'),
    answered: assignments.filter((a) => a.state === 'answered'),
    boards,
    truncated,
    voloError,
  })
}
