import { NextResponse } from 'next/server'
import { clearCredentials } from '@/lib/volo/oauth'

/** POST /api/volo/auth/disconnect — forget the stored Volo credentials. */
export const dynamic = 'force-dynamic'

export async function POST() {
  clearCredentials()
  return NextResponse.json({ connected: false })
}
