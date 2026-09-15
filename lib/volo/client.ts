/**
 * Volo MCP client.
 *
 * Volo exposes its API as MCP tools over streamable HTTP JSON-RPC. This calls
 * those tools directly rather than going through an MCP SDK: the panel needs
 * three read tools and one write, and a full MCP session would add a handshake
 * and session state for no benefit.
 *
 * Tool names and argument shapes here were taken from the server's own
 * `tools/list`, not from how the tools are surfaced elsewhere — the two do not
 * match. In particular `get_task` takes a task CODE (`TO-123`), there is no
 * generic task search (tasks are reached through their board), and moving a
 * task between states is `move_task`, because `update_task` has no status
 * field at all.
 */

import { VOLO_MCP_URL, accessToken } from '@/lib/volo/oauth'

export class VoloNotConnectedError extends Error {
  constructor() {
    super('Volo is not connected')
    this.name = 'VoloNotConnectedError'
  }
}

export class VoloError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoloError'
  }
}

interface McpResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  error?: { message?: string }
}

/**
 * Invoke one Volo MCP tool and return the parsed payload.
 *
 * The server answers either `application/json` or `text/event-stream`
 * depending on the request, so SSE frames are unwrapped before parsing.
 * Handling only one of the two produces a client that works until the server
 * changes content type.
 */
export async function callTool<T = unknown>(
  tool: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const token = await accessToken()
  if (!token) throw new VoloNotConnectedError()

  const res = await fetch(VOLO_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  })

  const raw = await res.text()
  const payload = raw.startsWith('event:') || raw.startsWith('data:')
    ? raw
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .pop() || ''
    : raw

  let parsed: McpResponse
  try {
    parsed = JSON.parse(payload) as McpResponse
  } catch {
    throw new VoloError(`Volo returned a non-JSON response (${res.status})`)
  }

  if (parsed.error?.message) throw new VoloError(parsed.error.message)

  // MCP reports tool failures as a successful JSON-RPC response with isError
  // set. Without this check a failed call reads as an empty result, and the
  // panel reports "no tasks" when the truth is "your token was rejected".
  const text = (parsed.result?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('')

  if (parsed.result?.isError) throw new VoloError(text || 'Volo rejected the call')
  if (!text) return undefined as T

  try {
    return JSON.parse(text) as T
  } catch {
    // Some tools answer with prose rather than JSON.
    return text as unknown as T
  }
}

// ---------------------------------------------------------------------------
// Shapes, as returned by Volo
// ---------------------------------------------------------------------------

export interface VoloColumn {
  id: string
  name: string
  order?: number
  color?: string
}

export interface VoloBoard {
  id: string
  name: string
  description?: string
  icon?: string
  prefix: string
  taskCounter?: number
  columns?: VoloColumn[]
  /**
   * Tasks hang off the board, not off its columns.
   *
   * Volo's columns carry no `tasks` array at all — each task points back at
   * its column through `columnId`. Grouping has to happen here; reading
   * `column.tasks` yields an empty board that looks like a permissions problem.
   */
  tasks?: VoloTask[]
}

export interface VoloTask {
  id: string
  /** Human code, e.g. `AUTO-12`. The field is `taskCode`, not `code`. */
  taskCode?: string
  taskNumber?: number
  title?: string
  description?: string
  assignee?: string
  priority?: string
  tags?: string[]
  columnId?: string
  boardId?: string
  inKanban?: boolean
}

/** A column together with the tasks that point at it. */
export interface VoloColumnWithTasks extends VoloColumn {
  tasks: VoloTask[]
}

/**
 * Group a board's tasks under their columns, in column order.
 *
 * Tasks whose `columnId` matches no column are dropped rather than bundled
 * into the first column, where they would look like real work in Todo.
 */
export function groupByColumn(board: VoloBoard): VoloColumnWithTasks[] {
  const columns = [...(board.columns || [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0)
  )
  const byColumn = new Map<string, VoloTask[]>()
  for (const task of board.tasks || []) {
    if (!task.columnId) continue
    const list = byColumn.get(task.columnId)
    if (list) list.push(task)
    else byColumn.set(task.columnId, [task])
  }
  return columns.map((column) => ({
    ...column,
    tasks: (byColumn.get(column.id) || []).sort(
      (a, b) => (a.taskNumber ?? 0) - (b.taskNumber ?? 0)
    ),
  }))
}

export async function listBoards(): Promise<VoloBoard[]> {
  const boards = await callTool<VoloBoard[]>('list_boards')
  return Array.isArray(boards) ? boards : []
}

/**
 * Fetch a board with its columns and tasks.
 *
 * `identifier` accepts a prefix (`TO`) or an id; anything that is not a bare
 * hex id is treated as a prefix, which is what a person types.
 */
export async function getBoard(identifier: string): Promise<VoloBoard | null> {
  const byPrefix = !/^[0-9a-f]{16,}$/i.test(identifier)
  const board = await callTool<VoloBoard | { board: VoloBoard }>('get_board', {
    identifier,
    byPrefix,
  })
  if (!board) return null
  return 'board' in board ? board.board : board
}

/** Fetch one task by its human code, e.g. `TO-123`. */
export async function getTask(
  taskCode: string
): Promise<{ task?: VoloTask; board?: VoloBoard } | null> {
  const result = await callTool<{ task?: VoloTask; board?: VoloBoard } | VoloTask>(
    'get_task',
    { taskCode }
  )
  if (!result) return null
  return 'task' in result || 'board' in result
    ? (result as { task?: VoloTask; board?: VoloBoard })
    : { task: result as VoloTask }
}

/** Move a task to a different column. */
export async function moveTask(
  boardId: string,
  taskId: string,
  columnId: string
): Promise<void> {
  await callTool('move_task', { boardId, taskId, columnId })
}

// ---------------------------------------------------------------------------
// Cross-board kanban — the "my work" view
// ---------------------------------------------------------------------------

/**
 * A task as returned by the unified kanban.
 *
 * Richer than the board shape: it carries where the task lives (board name and
 * prefix) and who it belongs to, because the whole point of this view is that
 * the tasks come from everywhere at once.
 */
export interface CrossBoardTask {
  taskId: string
  taskCode: string
  title: string
  boardId: string
  boardName: string
  boardPrefix: string
  columnId: string
  columnName: string
  columnType: string
  columnColor?: string
  priority?: string
  assignee?: string
  assigneeUserId?: string
  assigneeName?: string
  assigneeAvatar?: string
  ageDays?: number
  createdAt?: string
  updatedAt?: string
}

export interface CrossBoardColumn {
  /** Normalised type: not_started, in_progress, done. */
  type: string
  /** Human label for the type, already localised by Volo. */
  label: string
  tasks: CrossBoardTask[]
}

export interface CrossBoardKanban {
  columns: CrossBoardColumn[]
  boards: Array<{ id: string; name: string; prefix: string }>
  /** Raw column names found, mapped to their type — useful for diagnostics. */
  statuses: Array<{ name: string; type: string; color?: string; count: number }>
  people: Array<{ id?: string; name?: string; avatar?: string }>
  total: number
  truncated?: number
}

export interface CrossBoardOptions {
  /** Only tasks assigned to the connected user. */
  mine?: boolean
  includeDone?: boolean
  limit?: number
  boardIds?: string[]
}

/**
 * The unified kanban: one person's tasks wherever they live.
 *
 * Volo groups by column TYPE rather than name on purpose — boards name their
 * columns differently (`ToDo`, `Todo`, `Por Hacer`, `Backlog` all appear in
 * this workspace), so grouping by name would scatter the same state across
 * several columns.
 */
// Priority helpers live in ./priority so client components can import them
// without dragging this module's server-only dependencies into the browser.
export { PRIORITY_CODES, priorityRank, priorityCode } from '@/lib/volo/priority'

export async function getCrossBoardKanban(
  options: CrossBoardOptions = {}
): Promise<CrossBoardKanban> {
  const result = await callTool<CrossBoardKanban>('get_cross_board_kanban', {
    mine: options.mine ?? true,
    includeDone: options.includeDone ?? false,
    limit: options.limit ?? 200,
    ...(options.boardIds?.length ? { boardIds: options.boardIds } : {}),
  })

  return {
    columns: result?.columns || [],
    boards: result?.boards || [],
    statuses: result?.statuses || [],
    people: result?.people || [],
    total: result?.total ?? 0,
    truncated: result?.truncated,
  }
}
