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
import { FileTaskStore } from '@/lib/a2a/task-store'

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
  /**
   * Where the task is updated once the agent answers.
   *
   * The wait happens after the request has been answered, so the completion
   * cannot be published on the execution's event bus — it is written straight
   * to the store, which is what `GetTask` reads.
   */
  taskStore?: FileTaskStore
  /** Overrides for testing. */
  pollIntervalMs?: number
  replyTimeoutMs?: number
  /**
   * Await the reply inline instead of detaching it. Tests use this to assert
   * the completion path without racing a background timer; production never
   * sets it, because a blocking wait holds the HTTP request open.
   */
  awaitInline?: boolean
}

export class AmpBridgeExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>()

  constructor(private readonly options: AmpExecutorOptions) {}

  /**
   * Fail the task with a reason the caller can read.
   *
   * A status-update is only meaningful once the task it refers to exists: the
   * SDK answers "execution finished without a result, and no task context
   * found" — an internal error, not a failed task — if the first event it sees
   * is an update. `execute` therefore publishes the task before any validation,
   * so every path into here already has a task to refer to.
   */
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

    // Announce the task before anything else — before validation, before any
    // I/O. Every later event refers to it, and a client that is watching sees
    // it exist even if delivery is slow or the request turns out to be invalid.
    const task: Task = {
      id: taskId,
      contextId,
      status: status(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [requestContext.userMessage],
      metadata: undefined,
    }
    eventBus.publish(AgentEvent.task(task))

    if (!text) {
      this.fail(
        eventBus,
        taskId,
        contextId,
        'The request contained no text part to deliver.'
      )
      return
    }

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

    // Hand the request back now. A2A models this shape as a long-running task:
    // the caller gets `working` and polls GetTask. Awaiting the agent here
    // would hold the HTTP request open for as long as the agent takes to
    // answer — up to the whole reply timeout — which is precisely the blocking
    // behaviour that choosing store-and-forward delivery was meant to avoid.
    if (!this.options.awaitInline) {
      void this.completeInBackground(taskId, contextId, dispatched.ampMessageId, dispatchedAt)
      eventBus.finished()
      return
    }

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

  /**
   * Wait for the agent off the request path and record the outcome.
   *
   * Writes straight to the task store: by the time the reply lands, the
   * execution's event bus is finished and nothing is listening to it. A client
   * sees the result through GetTask.
   */
  private async completeInBackground(
    taskId: string,
    contextId: string,
    ampMessageId: string,
    dispatchedAt: string
  ): Promise<void> {
    const store = this.options.taskStore
    if (!store) return

    let reply
    try {
      reply = await this.awaitReply(taskId, ampMessageId, dispatchedAt)
    } catch {
      reply = null
    }

    const task = await store.load(taskId)
    if (!task) return

    if (this.cancelled.has(taskId)) {
      this.cancelled.delete(taskId)
      task.status = status(TaskState.TASK_STATE_CANCELED)
    } else if (reply) {
      task.artifacts = [
        ...(task.artifacts || []),
        {
          artifactId: `${taskId}-reply`,
          name: 'agent-reply',
          description: 'The agent\u2019s AMP reply to this task.',
          parts: [textPart(replyText(reply))],
          metadata: undefined,
          extensions: [],
        },
      ]
      task.status = status(TaskState.TASK_STATE_COMPLETED)
    } else {
      task.status = status(
        TaskState.TASK_STATE_FAILED,
        agentMessage(
          taskId,
          contextId,
          `${taskId}-timeout`,
          'The agent did not reply within the timeout. The message is still in its inbox.'
        )
      )
    }

    try {
      await store.save(task)
    } catch {
      // A task that cannot be persisted is not worth crashing a background
      // timer over; the client will keep seeing `working` until the retention
      // sweep removes it.
    }
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
