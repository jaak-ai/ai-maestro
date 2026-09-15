import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FileTaskStore } from '@/lib/a2a/task-store'
import { TaskState, type Task } from '@a2a-js/sdk'

let dir: string
let store: FileTaskStore

function makeTask(
  id: string,
  state: TaskState = TaskState.TASK_STATE_WORKING,
  timestamp = '2026-09-14T10:00:00.000Z',
  contextId = 'ctx-1'
): Task {
  return {
    id,
    contextId,
    status: { state, message: undefined, timestamp },
    artifacts: [],
    history: [],
    metadata: undefined,
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-store-'))
  store = new FileTaskStore(dir)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('FileTaskStore', () => {
  it('round-trips a task through disk', async () => {
    await store.save(makeTask('t1'))
    const loaded = await store.load('t1')
    expect(loaded?.id).toBe('t1')
    expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_WORKING)
  })

  // The whole reason this store exists instead of InMemoryTaskStore: a task
  // must survive the process that created it.
  it('survives a new store instance over the same directory', async () => {
    await store.save(makeTask('t1'))
    const reopened = new FileTaskStore(dir)
    expect((await reopened.load('t1'))?.id).toBe('t1')
  })

  it('returns undefined for an unknown task', async () => {
    expect(await store.load('nope')).toBeUndefined()
  })

  it('treats a corrupt file as absent rather than throwing', async () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json', 'utf-8')
    expect(await store.load('bad')).toBeUndefined()
  })

  // Task ids reach the filesystem, so a traversal attempt must not escape.
  it('refuses to write a task whose id escapes the directory', async () => {
    await expect(store.save(makeTask('../escape'))).rejects.toThrow()
  })

  it('refuses to read a traversing id', async () => {
    expect(await store.load('../../etc/passwd')).toBeUndefined()
  })

  it('lists every stored task', async () => {
    await store.save(makeTask('t1'))
    await store.save(makeTask('t2'))
    const res = await store.list({} as never)
    expect(res.totalSize).toBe(2)
  })

  it('filters by contextId', async () => {
    await store.save(makeTask('t1', TaskState.TASK_STATE_WORKING, undefined, 'a'))
    await store.save(makeTask('t2', TaskState.TASK_STATE_WORKING, undefined, 'b'))
    const res = await store.list({ contextId: 'a' } as never)
    expect(res.tasks.map((t) => t.id)).toEqual(['t1'])
  })

  it('filters by status', async () => {
    await store.save(makeTask('t1', TaskState.TASK_STATE_WORKING))
    await store.save(makeTask('t2', TaskState.TASK_STATE_COMPLETED))
    const res = await store.list({
      status: TaskState.TASK_STATE_COMPLETED,
    } as never)
    expect(res.tasks.map((t) => t.id)).toEqual(['t2'])
  })

  it('returns newest first', async () => {
    await store.save(makeTask('old', TaskState.TASK_STATE_WORKING, '2026-01-01T00:00:00.000Z'))
    await store.save(makeTask('new', TaskState.TASK_STATE_WORKING, '2026-09-01T00:00:00.000Z'))
    const res = await store.list({} as never)
    expect(res.tasks[0].id).toBe('new')
  })

  it('pages with a usable next token', async () => {
    for (const id of ['t1', 't2', 't3']) await store.save(makeTask(id))
    const first = await store.list({ pageSize: 2 } as never)
    expect(first.tasks).toHaveLength(2)
    expect(first.nextPageToken).toBe('2')

    const second = await store.list({
      pageSize: 2,
      pageToken: first.nextPageToken,
    } as never)
    expect(second.tasks).toHaveLength(1)
    expect(second.nextPageToken).toBe('')
  })

  it('deletes a task', async () => {
    await store.save(makeTask('t1'))
    await store.delete('t1')
    expect(await store.load('t1')).toBeUndefined()
  })

  it('lists nothing when the directory does not exist yet', async () => {
    const fresh = new FileTaskStore(path.join(dir, 'missing'))
    expect((await fresh.list({} as never)).totalSize).toBe(0)
  })
})
