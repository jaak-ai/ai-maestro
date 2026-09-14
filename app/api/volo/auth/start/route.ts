import { NextRequest, NextResponse } from 'next/server'
import { beginAuthorization } from '@/lib/volo/oauth'

/**
 * GET /api/volo/auth/start
 *
 * Redirects the browser to Volo's consent screen.
 *
 * A redirect rather than a JSON payload with a URL: the button is a plain link,
 * so the flow works without JavaScript and cannot be blocked as a popup.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const returnTo = request.nextUrl.searchParams.get('returnTo') || '/volo'

  // Only same-site paths: an absolute URL here would turn this endpoint into
  // an open redirect.
  const safeReturnTo = returnTo.startsWith('/') && !returnTo.startsWith('//')
    ? returnTo
    : '/volo'

  try {
    const { url } = await beginAuthorization(safeReturnTo)
    return NextResponse.redirect(url)
  } catch (err) {
    return NextResponse.redirect(
      new URL(
        `${safeReturnTo}?error=${encodeURIComponent((err as Error).message)}`,
        request.nextUrl.origin
      )
    )
  }
}
