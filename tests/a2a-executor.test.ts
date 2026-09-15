import { describe, it, expect, vi, beforeEach } from 'vitest'

const dispatchToAgent = vi.fn()
const findReply = vi.fn()

vi.mock('@/lib/a2a/amp-bridge', () => ({
  dispatchToAgent: (...args: unknown[]) => dispatchToAgent(...args),
  findReply: (...args: unknown[]) => findReply(...args),
  replyText: (m: { content?: { message?: string } }) =>
    m.content?.message ?? '',
}))

import { AmpBridgeExecutor, textFromMessage } from '@/lib/a2a/executor'
import { Role, TaskState } from '@a2a-js/sdk'
import type { Message as A2AMessage } from '@a2a-js/sdk'

function userMessage(text: string): A2AMessage {
  return {
    messageId: 'm1',
    taskId: 't1',
    contextId: 'c1',
    role: Role.ROLE_USER,
    parts: text
      ? [
          {
            content: { $case: 'text', value: text },
            metadata: undefined,
            filename: '',
            mediaType: 'text/plain',
          },
        ]
      : [],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

/** Minimal ExecutionEventBus that records what the executor published. */
function makeBus() {
  const events: any[] = []
  let finished = false
  return {
    events,
    get finished() {
      return finished
    },
    bus: {
      publish: (e: any) => events.push(e),
      finished: () => {
        finished = true
      },
      on: () => ({}) as any,
      off: () => ({}) as any,
      once: () => ({}) as any,
      removeAllListeners: () => ({}) as any,
    } as any,
  }
}

function context(text: string) {
  return {
    taskId: 't1',
    contextId: 'c1',
    userMessage: userMessage(text),
  } as any
}

/** States of every status-update the executor published, in order. */
function states(events: any[]): TaskState[] {
  return events
    .filter((e) => e.kind === 'statusUpdate')
    .map((e) => e.data.status.state)
}

describe('textFromMessage', () => {
  it('reads the protobuf-style text oneof used by A2A v1.0', () => {
    expect(textFromMessage(userMessage('hola'))).toBe('hola')
  })

  it('returns empty string when there are no parts', () => {
    expect(textFromMessage(userMessage(''))).toBe('')
  })
})

describe('AmpBridgeExecutor', () => {
  beforeEach(() => {
    dispatchToAgent.mockReset()
    findReply.mockReset()
  })

  it('completes the task with the agent reply as an artifact', async () => {
    dispatchToAgent.mockResolvedValue({
      ampMessageId: 'amp-1',
      notified: true,
      deferred: false,
    })
    findReply.mockResolvedValue({ content: { message: 'respuesta del agente' } })

    // NOTE: `finished` is a getter; keep the object rather than spreading it,
    // or it is evaluated once at destructuring time and always reads false.
    const harness = makeBus()
    const { bus, events } = harness
    const exec = new AmpBridgeExecutor({
      agentIdentifier: 'backend-api',
      awaitInline: true,
      pollIntervalMs: 1,
      replyTimeoutMs: 500,
    })
    await exec.execute(context('haz algo'), bus)

    expect(states(events)).toEqual([
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_COMPLETED,
    ])

    const artifact = events.find((e) => e.kind === 'artifactUpdate')
    expect(artifact.data.artifact.parts[0].content.value).toBe(
      'respuesta del agente'
    )
    expect(harness.finished).toBe(true)
  })

  it('rejects a request with no text instead of sending an empty message', async () => {
    const { bus, events } = makeBus()
    const exec = new AmpBridgeExecutor({ agentIdentifier: 'backend-api' })
    await exec.execute(context(''), bus)

    expect(dispatchToAgent).not.toHaveBeenCalled()
    expect(states(events)).toEqual([TaskState.TASK_STATE_FAILED])
  })

  // Caught live, not in unit tests: a status-update with no preceding task made
  // the SDK answer "execution finished without a result, and no task context
  // found" — an internal error instead of a readable failed task.
  it('publishes the task before any status update, even when rejecting', async () => {
    const { bus, events } = makeBus()
    const exec = new AmpBridgeExecutor({ agentIdentifier: 'backend-api' })
    await exec.execute(context(''), bus)

    expect(events[0].kind).toBe('task')
  })

  it('publishes the task first on a delivery failure too', async () => {
    dispatchToAgent.mockRejectedValue(new Error('boom'))
    const { bus, events } = makeBus()
    const exec = new AmpBridgeExecutor({ agentIdentifier: 'backend-api' })
    await exec.execute(context('haz algo'), bus)

    expect(events[0].kind).toBe('task')
  })

  // A queued message for an offline agent is the designed behaviour, not an
  // error — but the client must be told, or it cannot tell "slow" from "stuck".
  it('says so when the agent was offline and the message was queued', async () => {
    dispatchToAgent.mockResolvedValue({
      ampMessageId: 'amp-1',
      notified: false,
      deferred: true,
    })
    findReply.mockResolvedValue({ content: { message: 'ok' } })

    const { bus, events } = makeBus()
    const exec = new AmpBridgeExecutor({
      agentIdentifier: 'backend-api',
      awaitInline: true,
      pollIntervalMs: 1,
      replyTimeoutMs: 500,
    })
    await exec.execute(context('haz algo'), bus)

    const working = events.find(
      (e) =>
        e.kind === 'statusUpdate' &&
        e.data.status.state === TaskState.TASK_STATE_WORKING
    )
    expect(working.data.status.message.parts[0].content.value).toContain(
      'offline'
    )
  })

  it('fails the task when the agent never replies', async () => {
    dispatchToAgent.mockResolvedValue({
      ampMessageId: 'amp-1',
      notified: true,
      deferred: false,
    })
    findReply.mockResolvedValue(null)

    const { bus, events } = makeBus()
    const exec = new AmpBridgeExecutor({
      agentIdentifier: 'backend-api',
      awaitInline: true,
      pollIntervalMs: 1,
      replyTimeoutMs: 30,
    })
    await exec.execute(context('haz algo'), bus)

    expect(states(events)).toContain(TaskState.TASK_STATE_FAILED)
  })

  it('surfaces a delivery failure instead of hanging', async () => {
    dispatchToAgent.mockRejectedValue(new Error('agente desconocido'))

    const { bus, events } = makeBus()
    const exec = new AmpBridgeExecutor({ agentIdentifier: 'nope' })
    await exec.execute(context('haz algo'), bus)

    const failed = events.find(
      (e) =>
        e.kind === 'statusUpdate' &&
        e.data.status.state === TaskState.TASK_STATE_FAILED
    )
    expect(failed.data.status.message.parts[0].content.value).toContain(
      'agente desconocido'
    )
  })

  it('stops waiting once the task is cancelled', async () => {
    dispatchToAgent.mockResolvedValue({
      ampMessageId: 'amp-1',
      notified: true,
      deferred: false,
    })
    findReply.mockResolvedValue(null)

    const { bus, events } = makeBus()
    const exec = new AmpBridgeExecutor({
      agentIdentifier: 'backend-api',
      awaitInline: true,
      pollIntervalMs: 1,
      replyTimeoutMs: 5000,
    })
    const running = exec.execute(context('haz algo'), bus)
    await new Promise((r) => setTimeout(r, 10))
    await exec.cancelTask('t1')
    await running

    expect(states(events)).toContain(TaskState.TASK_STATE_CANCELED)
  })
})

// Caught live: SendMessage held the HTTP request open for the whole reply
// timeout because execute() awaited the agent. A2A models this as a
// long-running task — return `working`, let the client poll GetTask.
describe('AmpBridgeExecutor does not block the request', () => {
  beforeEach(() => {
    dispatchToAgent.mockReset()
    findReply.mockReset()
  })

  it('returns as soon as the message is delivered', async () => {
    dispatchToAgent.mockResolvedValue({
      ampMessageId: 'amp-1',
      notified: true,
      deferred: false,
    })
    // An agent that never answers: the old code would sit here for the whole
    // timeout.
    findReply.mockImplementation(() => new Promise(() => {}))

    const harness = makeBus()
    const exec = new AmpBridgeExecutor({
      agentIdentifier: 'backend-api',
      pollIntervalMs: 1,
      replyTimeoutMs: 60_000,
    })

    const started = Date.now()
    await exec.execute(context('haz algo'), harness.bus)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(1000)
    expect(harness.finished).toBe(true)
    expect(states(harness.events)).toEqual([TaskState.TASK_STATE_WORKING])
  })
})
