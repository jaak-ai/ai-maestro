/**
 * A2A AgentExecutor backed by the AMP bridge.
 *
 * Receives an A2A `message/send`, delivers it to the target agent's AMP inbox,
 * and waits for the agent's reply to resolve the task.
 *
 * ## Why this polls
 *
 * AMP has no completion callback: an agent answers by sending its own message,
 * which lands in its sent box. Detecting that requires either polling or a hook
 * inside AMP's delivery path. Polling is used here because it adds no changes
 * to existing message code — this ships as an upstream contribution, and a
 * self-contained feature is far likelier to be accepted than one that reaches
 * into the delivery pipeline. If the poll's cost ever matters, the hook is the
 * upgrade path and only `awaitReply` needs replacing.
 */

import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import {
  Role,
  TaskState,
  type Message as A2AMessage,
  type Part,
  type Task,
  type TaskStatus,
} from '@a2a-js/sdk'
import { dispatchToAgent, findReply, replyText } from '@/lib/a2a/amp-bridge'

/** How often to check whether the agent has answered. */
const POLL_INTERVAL_MS = 3000

/**
 * How long to wait for a reply before giving up.
 *
 * Generous on purpose: the whole point of bridging over AMP rather than
 * injecting into a live terminal is that the target may be offline when the
 * task arrives and answer once it wakes. A short timeout would throw away the
 * property that motivated the design.
 */
const REPLY_TIMEOUT_MS = 15 * 60 * 1000

/** A2A v1.0 parts carry their payload in a protobuf-style `content` oneof. */
function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  }
}

/** Extract the caller's text from an A2A message's parts. */
export function textFromMessage(message: A2AMessage): string {
  return (message.parts || [])
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** First line of the caller's text, used as the AMP subject line. */
function subjectFor(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() || 'A2A task'
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine
}

function agentMessage(
  taskId: string,
  contextId: string,
  messageId: string,
  text: string
): A2AMessage {
  return {
    messageId,
    taskId,
    contextId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function status(
  state: TaskState,
  message?: A2AMessage
): TaskStatus {
  return {
    state,
    message,
    timestamp: new Date().toISOString(),
  }
}

export interface AmpExecutorOptions {
  /** Registry id, name or alias of the agent this executor speaks for. */
  agentIdentifier: string
  /** Overrides for testing. */
  pollIntervalMs?: number
  replyTimeoutMs?: number
}

export class AmpBridgeExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>()

  constructor(private readonly options: AmpExecutorOptions) {}

  private fail(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    reason: string
  ): void {
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(
          TaskState.TASK_STATE_FAILED,
          agentMessage(taskId, contextId, `${taskId}-failed`, reason)
        ),
        metadata: undefined,
      })
    )
    eventBus.finished()
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const { taskId, contextId } = requestContext
    const text = textFromMessage(requestContext.userMessage)

    if (!text) {
      this.fail(
        eventBus,
        taskId,
        contextId,
        'The request contained no text part to deliver.'
      )
      return
    }

    // Announce the task before doing any I/O, so a client that is watching
    // sees it exist even if delivery is slow.
    const task: Task = {
      id: taskId,
      contextId,
      status: status(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [requestContext.userMessage],
      metadata: undefined,
    }
    eventBus.publish(AgentEvent.task(task))

    let dispatched
    try {
      dispatched = await dispatchToAgent({
        toAgent: this.options.agentIdentifier,
        subject: subjectFor(text),
        text,
      })
    } catch (err) {
      this.fail(
        eventBus,
        taskId,
        contextId,
        `Could not deliver to the agent: ${(err as Error).message}`
      )
      return
    }

    // `deferred` means the agent was not reachable and the message is queued.
    // Say so rather than leaving the client to guess why nothing is happening.
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(
          TaskState.TASK_STATE_WORKING,
          agentMessage(
            taskId,
            contextId,
            `${taskId}-working`,
            dispatched.deferred
              ? 'Delivered to the agent inbox. The agent is offline; it will be processed when it wakes.'
              : 'Delivered to the agent inbox.'
          )
        ),
        metadata: undefined,
      })
    )

    const dispatchedAt = new Date().toISOString()
    const reply = await this.awaitReply(
      taskId,
      dispatched.ampMessageId,
      dispatchedAt
    )

    if (this.cancelled.has(taskId)) {
      this.cancelled.delete(taskId)
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskState.TASK_STATE_CANCELED),
          metadata: undefined,
        })
      )
      eventBus.finished()
      return
    }

    if (!reply) {
      this.fail(
        eventBus,
        taskId,
        contextId,
        'The agent did not reply within the timeout. The message is still in its inbox.'
      )
      return
    }

    eventBus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: `${taskId}-reply`,
          name: 'agent-reply',
          description: 'The agent’s AMP reply to this task.',
          parts: [textPart(replyText(reply))],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      })
    )
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_COMPLETED),
        metadata: undefined,
      })
    )
    eventBus.finished()
  }

  /** Poll the agent's sent box until the reply appears, or time out. */
  private async awaitReply(
    taskId: string,
    ampMessageId: string,
    sentAfter: string
  ) {
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS
    const deadline =
      Date.now() + (this.options.replyTimeoutMs ?? REPLY_TIMEOUT_MS)

    while (Date.now() < deadline) {
      if (this.cancelled.has(taskId)) return null

      const reply = await findReply(
        this.options.agentIdentifier,
        ampMessageId,
        sentAfter
      )
      if (reply) return reply

      await new Promise((resolve) => setTimeout(resolve, interval))
    }

    return null
  }

  /**
   * Mark a task cancelled.
   *
   * The AMP message already sits in the agent's inbox and cannot be recalled,
   * so cancellation stops this server waiting for the answer — it does not
   * stop the agent from eventually acting on the request. The distinction is
   * reported to the client rather than glossed over.
   */
  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.add(taskId)
  }
}
