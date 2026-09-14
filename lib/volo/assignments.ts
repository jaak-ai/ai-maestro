/**
 * Local record of which Volo tasks were handed to which agent.
 *
 * ## Why this has to exist
 *
 * Volo knows a task's column; it does not know that AI Maestro delivered it to
 * an agent. Delivery goes over AMP, which leaves a message in an inbox and
 * nothing else. So the middle of the development queue — "this is with an
 * agent right now" — is not derivable from Volo or from AMP: it is a fact only
 * this server witnessed, and it has to be written down or it is lost.
 *
 * Kept local on purpose. It is AI Maestro's view of its own delegation, not a
 * second source of truth about the task: Volo remains authoritative for what
 * the task *is* and what column it sits in.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

export type AssignmentState = 'delivered' | 'answered' | 'cancelled'

export interface Assignment {
  /** Volo task code, e.g. `TO-123`. The key. */
  taskCode: string
  taskTitle: string
  boardPrefix: string
  boardName: string
  agentId: string
  agentName: string
  /** AMP message delivered to the agent — the correlation key for the reply. */
  messageId: string
  assignedAt: string
  /** True when the agent was offline and the message was queued. */
  deferred: boolean
  state: AssignmentState
  /** When a reply was first seen. */
  answeredAt?: string
  /** The agent's reply text, once it arrives. */
  answer?: string
  /** Whether the task was also advanced in Volo at assignment time. */
  movedInVolo?: boolean
}

function storePath(): string {
  return path.join(os.homedir(), '.aimaestro', 'volo', 'assignments.json')
}

function readAll(): Assignment[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf-8'))
    return Array.isArray(parsed) ? (parsed as Assignment[]) : []
  } catch {
    return []
  }
}

function writeAll(assignments: Assignment[]): void {
  const file = storePath()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Write-then-rename: a crash mid-write leaves the previous list intact rather
  // than a truncated file that parses as "nothing was ever assigned".
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(assignments, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

export function listAssignments(): Assignment[] {
  return readAll().sort((a, b) => b.assignedAt.localeCompare(a.assignedAt))
}

/** The current assignment for a task, if it is still with an agent. */
export function activeAssignment(taskCode: string): Assignment | null {
  return (
    readAll().find(
      (a) => a.taskCode === taskCode && a.state !== 'cancelled'
    ) || null
  )
}

/**
 * Record a delivery.
 *
 * Re-assigning a task replaces its previous record rather than appending:
 * the queue answers "where is this task now", and two live rows for one task
 * would put it in two columns at once.
 */
export function recordAssignment(assignment: Assignment): void {
  const others = readAll().filter((a) => a.taskCode !== assignment.taskCode)
  writeAll([...others, assignment])
}

export function markAnswered(taskCode: string, answer: string): void {
  const all = readAll()
  const found = all.find((a) => a.taskCode === taskCode)
  if (!found || found.state === 'answered') return

  found.state = 'answered'
  found.answeredAt = new Date().toISOString()
  found.answer = answer
  writeAll(all)
}

/** Remove a task from the queue without implying the agent finished it. */
export function cancelAssignment(taskCode: string): boolean {
  const all = readAll()
  const found = all.find((a) => a.taskCode === taskCode)
  if (!found) return false

  found.state = 'cancelled'
  writeAll(all)
  return true
}

/** Drop cancelled rows and anything answered longer ago than `days`. */
export function pruneAssignments(days = 30): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const all = readAll()
  const kept = all.filter((a) => {
    if (a.state === 'cancelled') return false
    if (a.state !== 'answered') return true
    return Date.parse(a.answeredAt || a.assignedAt) > cutoff
  })
  if (kept.length !== all.length) writeAll(kept)
  return all.length - kept.length
}
