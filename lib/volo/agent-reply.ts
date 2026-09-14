/**
 * Find an agent's AMP reply to a delivered task.
 *
 * Deliberately duplicated from the A2A bridge rather than shared: the two
 * features ship on separate branches and neither should have to land for the
 * other to work. It is a dozen lines, and coupling them would make a Volo fix
 * wait on an A2A review.
 */

import { getMessage, listSentMessages, type Message } from '@/lib/messageQueue'

/**
 * How many recent sent messages to inspect.
 *
 * `listSentMessages` returns summaries, which carry no `inReplyTo`, so the
 * correlation needs the full message. The scan is bounded rather than reading
 * every message the agent has ever sent.
 */
const SCAN_LIMIT = 50

/**
 * The agent's reply to `messageId`, or null while it has not answered.
 *
 * `sentAfter` bounds the search: a reply cannot predate the request.
 */
export async function findAgentReply(
  agentIdentifier: string,
  messageId: string,
  sentAfter?: string
): Promise<Message | null> {
  const summaries = await listSentMessages(agentIdentifier, { limit: SCAN_LIMIT })

  const threshold = sentAfter ? Date.parse(sentAfter) : NaN
  const candidates = Number.isNaN(threshold)
    ? summaries
    : summaries.filter((s) => Date.parse(s.timestamp) >= threshold)

  for (const summary of candidates) {
    const full = await getMessage(agentIdentifier, summary.id, 'sent')
    if (full?.inReplyTo === messageId) return full
  }

  return null
}

/** Plain text of a reply. */
export function replyText(message: Message): string {
  return message.content?.message ?? ''
}
