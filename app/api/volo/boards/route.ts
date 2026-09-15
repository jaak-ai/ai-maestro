import { NextResponse } from 'next/server'
import { listBoards, VoloNotConnectedError } from '@/lib/volo/client'

/** GET /api/volo/boards — the boards this Volo account can see. */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json({ boards: await listBoards() })
  } catch (err) {
    if (err instanceof VoloNotConnectedError) {
      // 409, not 401: the caller is authenticated with AI Maestro; what is
      // missing is the downstream Volo connection, and the panel reacts by
      // showing the connect button rather than a login error.
      return NextResponse.json({ error: 'not_connected' }, { status: 409 })
    }
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 }
    )
  }
}
