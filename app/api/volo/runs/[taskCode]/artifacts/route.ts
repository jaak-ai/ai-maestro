import { NextRequest, NextResponse } from 'next/server'
import { listArtifacts, readArtifact } from '@/lib/volo/workspace'

/**
 * GET /api/volo/runs/:taskCode/artifacts        → list
 * GET /api/volo/runs/:taskCode/artifacts?path=x → read one
 *
 * The artifacts a task-orchestrator run wrote: the preliminary analysis, the
 * plan, the developer log, the closing notes. Read-only.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ taskCode: string }> }
) {
  const { taskCode } = await context.params
  const wanted = request.nextUrl.searchParams.get('path')

  if (!wanted) {
    return NextResponse.json({ artifacts: listArtifacts(taskCode) })
  }

  const artifact = readArtifact(taskCode, wanted)
  if (!artifact) {
    // Also the answer when the path tried to escape the workspace: a traversal
    // attempt learns nothing it would not learn from a missing file.
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  return NextResponse.json(artifact)
}
