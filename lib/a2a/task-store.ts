/**
 * File-backed A2A TaskStore.
 *
 * The SDK ships `InMemoryTaskStore`, which is fine for a process that owns its
 * own lifetime. AI Maestro does not: it runs under PM2 and is restarted by
 * updates, crashes and `pm2 restart`. An A2A task bridged over AMP can legally
 * sit in `working` for minutes — that is the whole point of store-and-forward
 * delivery to an agent that is currently offline — so an in-memory store would
 * silently drop exactly the long-running tasks this design exists to support.
 *
 * Tasks live alongside the rest of AI Maestro's state in ~/.aimaestro, one
 * JSON file per task, so a restart resumes from disk and an operator can see
 * what is outstanding without a running server.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import {
  type ListTasksRequest,
  type ListTasksResponse,
  type Task,
} from '@a2a-js/sdk'

/** Directory holding one JSON file per A2A task. */
export function taskStoreDir(): string {
  return path.join(os.homedir(), '.aimaestro', 'a2a', 'tasks')
}

/**
 * Task ids come from the SDK, but this builds a filesystem path from them, so
 * treat them as untrusted: reject anything that is not a plain id rather than
 * letting `../` escape the store directory.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/

function taskPath(taskId: string): string | null {
  if (!SAFE_ID.test(taskId) || taskId === '.' || taskId === '..') return null
  return path.join(taskStoreDir(), `${taskId}.json`)
}

export class FileTaskStore implements TaskStore {
  constructor(private readonly dir: string = taskStoreDir()) {}

  private pathFor(taskId: string): string | null {
    const p = taskPath(taskId)
    if (!p) return null
    return path.join(this.dir, path.basename(p))
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    const file = this.pathFor(task.id)
    if (!file) throw new Error(`Refusing to store task with unsafe id: ${task.id}`)

    fs.mkdirSync(this.dir, { recursive: true })

    // Write-then-rename: a crash mid-write leaves the previous version intact
    // rather than a truncated file that fails to parse on the next load.
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
  }

  async load(
    taskId: string,
    _context?: ServerCallContext
  ): Promise<Task | undefined> {
    const file = this.pathFor(taskId)
    if (!file) return undefined

    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as Task
    } catch {
      // Missing or unparseable: treat as absent. A corrupt file must not take
      // the server down on an unrelated request.
      return undefined
    }
  }

  async list(
    params: ListTasksRequest,
    _context?: ServerCallContext
  ): Promise<ListTasksResponse> {
    let files: string[]
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'))
    } catch {
      files = []
    }

    let tasks: Task[] = []
    for (const f of files) {
      const task = await this.load(path.basename(f, '.json'))
      if (task) tasks.push(task)
    }

    if (params?.contextId) {
      tasks = tasks.filter((t) => t.contextId === params.contextId)
    }
    // TASK_STATE_UNSPECIFIED is the proto default for "no filter" and its
    // numeric value is 0, so a plain truthiness check already skips it.
    if (params?.status) {
      tasks = tasks.filter((t) => t.status?.state === params.status)
    }
    if (params?.statusTimestampAfter) {
      const after = Date.parse(params.statusTimestampAfter)
      if (!Number.isNaN(after)) {
        tasks = tasks.filter((t) => {
          const ts = t.status?.timestamp
          return ts ? Date.parse(ts) > after : false
        })
      }
    }

    // Newest first, so a page of results is the most useful one.
    tasks.sort((a, b) =>
      (b.status?.timestamp || '').localeCompare(a.status?.timestamp || '')
    )

    const totalSize = tasks.length
    const pageSize = params?.pageSize && params.pageSize > 0 ? params.pageSize : totalSize
    const start = params?.pageToken ? Number.parseInt(params.pageToken, 10) || 0 : 0
    const page = tasks.slice(start, start + pageSize)
    const nextStart = start + page.length

    return {
      tasks: page,
      nextPageToken: nextStart < totalSize ? String(nextStart) : '',
      pageSize: page.length,
      totalSize,
    }
  }

  /** Remove a task file. Used by retention; not part of the SDK interface. */
  async delete(taskId: string): Promise<void> {
    const file = this.pathFor(taskId)
    if (!file) return
    try {
      fs.unlinkSync(file)
    } catch {
      /* already gone */
    }
  }
}
