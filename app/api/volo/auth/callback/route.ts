import { NextRequest, NextResponse } from 'next/server'
import { completeAuthorization } from '@/lib/volo/oauth'

/**
 * GET /api/volo/auth/callback
 *
 * Where Volo sends the browser back. Exchanges the code and returns the user
 * to the page they started from.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const origin = request.nextUrl.origin

  const error = params.get('error')
  if (error) {
    return NextResponse.redirect(
      new URL(`/volo?error=${encodeURIComponent(error)}`, origin)
    )
  }

  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) {
    return NextResponse.redirect(new URL('/volo?error=missing_code', origin))
  }

  try {
    const { returnTo } = await completeAuthorization(state, code)
    return NextResponse.redirect(new URL(`${returnTo}?connected=1`, origin))
  } catch (err) {
    return NextResponse.redirect(
      new URL(
        `/volo?error=${encodeURIComponent((err as Error).message)}`,
        origin
      )
    )
  }
}
