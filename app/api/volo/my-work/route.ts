import { NextRequest, NextResponse } from 'next/server'
import { getCrossBoardKanban, VoloNotConnectedError } from '@/lib/volo/client'

/**
 * GET /api/volo/my-work
 *
 * The unified kanban behind Volo's "my work" view: one person's tasks across
 * every board, grouped by column type rather than column name.
 *
 * Query: mine=false (whole team), includeDone=true, limit=N
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const limit = Number.parseInt(params.get('limit') || '', 10)

  try {
    const kanban = await getCrossBoardKanban({
      mine: params.get('mine') !== 'false',
      includeDone: params.get('includeDone') === 'true',
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200,
    })
    return NextResponse.json(kanban)
  } catch (err) {
    if (err instanceof VoloNotConnectedError) {
      // 409, not 401: the caller is authenticated with AI Maestro; what is
      // missing is the downstream Volo connection.
      return NextResponse.json({ error: 'not_connected' }, { status: 409 })
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
