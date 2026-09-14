import { NextRequest, NextResponse } from 'next/server'
import { getBoard, VoloNotConnectedError } from '@/lib/volo/client'

/**
 * GET /api/volo/boards/:identifier
 *
 * A board with its columns and tasks. `identifier` is a prefix (TO) or an id.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await context.params

  try {
    const board = await getBoard(identifier)
    if (!board) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json({ board })
  } catch (err) {
    if (err instanceof VoloNotConnectedError) {
      return NextResponse.json({ error: 'not_connected' }, { status: 409 })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
