/**
 * A2A → AMP bridge
 *
 * Translates an incoming A2A task into an AMP message delivered to the target
 * agent's inbox, and correlates the agent's AMP reply back to the A2A task.
 *
 * Why AMP rather than injecting into the agent's tmux session: AMP is
 * store-and-forward, so a task addressed to an agent that is currently offline
 * is delivered when it wakes instead of failing. The cost is that the reply is
 * deferred — the A2A task stays `working` until the agent answers — which is
 * why the Agent Card does not advertise streaming.
 */

import { sendFromUI } from '@/lib/message-send'
import { getMessage, listSentMessages, type Message } from '@/lib/messageQueue'

/**
 * Sender identity used when an external A2A caller has not been authenticated.
 *
 * `sendFromUI` tolerates a sender that does not resolve to a registry agent —
 * it records the message as unverified rather than rejecting it. That is the
 * honest representation of an anonymous external caller, and it preserves who
 * called instead of collapsing every external request onto one synthetic
 * gateway identity.
 */
export const ANONYMOUS_A2A_SENDER = 'a2a-caller'

export interface BridgedTask {
  /** Id of the AMP message delivered to the agent. */
  ampMessageId: string
  /** Whether the agent was woken (false = queued for an offline agent). */
  notified: boolean
  /** Whether delivery was deferred because the agent was unreachable. */
  deferred: boolean
}

export interface DispatchOptions {
  /** Registry agent id, name or alias of the recipient. */
  toAgent: string
  /** Subject line shown in the agent's inbox. */
  subject: string
  /** The caller's message text. */
  text: string
  /**
   * Identity of the A2A caller, when authentication established one.
   * Falls back to an anonymous marker so the agent can still see that the
   * request arrived over A2A rather than from another agent in the mesh.
   */
  callerId?: string
}

/**
 * Deliver an A2A message to an agent's AMP inbox.
 *
 * Returns the AMP message id, which is the correlation key: the agent's reply
 * carries it in `inReplyTo`.
 */
export async function dispatchToAgent(
  options: DispatchOptions
): Promise<BridgedTask> {
  const outcome = await sendFromUI({
    from: options.callerId?.trim() || ANONYMOUS_A2A_SENDER,
    to: options.toAgent,
    subject: options.subject,
    content: {
      type: 'request',
      message: options.text,
    },
    priority: 'normal',
  })

  return {
    ampMessageId: outcome.message.id,
    notified: outcome.notified,
    deferred: outcome.deferred === true,
  }
}

/**
 * How many recent sent messages to inspect when correlating a reply.
 *
 * `listSentMessages` returns summaries, which do not carry `inReplyTo`, so the
 * correlation needs the full message. Scanning the whole sent box on every
 * poll would read every message the agent has ever sent, so the search is
 * bounded to messages sent after the task was dispatched, newest first.
 */
const REPLY_SCAN_LIMIT = 50

/**
 * Look for the agent's reply to a bridged task.
 *
 * The reply is a message the AGENT sent (so it lives in the agent's sent box)
 * whose `inReplyTo` is the id of the message we delivered. Returns null while
 * the agent has not answered yet — the task stays `working`.
 *
 * `sentAfter` bounds the scan: a reply cannot predate the request it answers.
 */
export async function findReply(
  agentIdentifier: string,
  ampMessageId: string,
  sentAfter?: string
): Promise<Message | null> {
  const summaries = await listSentMessages(agentIdentifier, {
    limit: REPLY_SCAN_LIMIT,
  })

  const threshold = sentAfter ? Date.parse(sentAfter) : NaN
  const candidates = Number.isNaN(threshold)
    ? summaries
    : summaries.filter((s) => Date.parse(s.timestamp) >= threshold)

  for (const summary of candidates) {
    const full = await getMessage(agentIdentifier, summary.id, 'sent')
    if (full?.inReplyTo === ampMessageId) return full
  }

  return null
}

/**
 * Plain text of a reply, for publishing as an A2A artifact.
 */
export function replyText(message: Message): string {
  return message.content?.message ?? ''
}
