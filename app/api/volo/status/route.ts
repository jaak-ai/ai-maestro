import { NextResponse } from 'next/server'
import { connectionStatus, redirectUri } from '@/lib/volo/oauth'

/**
 * GET /api/volo/status
 *
 * Whether Volo is connected. The panel calls this before anything else so it
 * can show a connect prompt instead of an empty board that looks like a bug.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    ...connectionStatus(),
    // Surfaced so the operator can see which redirect Volo must accept when a
    // registration is rejected — the usual cause is a host URL that changed.
    redirectUri: redirectUri(),
  })
}
