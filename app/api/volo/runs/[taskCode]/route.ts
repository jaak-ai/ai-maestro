import { NextRequest, NextResponse } from 'next/server'
import { phaseLabel, readRun } from '@/lib/volo/workspace'

/**
 * GET /api/volo/runs/:taskCode
 *
 * State of a task-orchestrator run: current phase, whether it is parked on a
 * human checkpoint, and the last few events.
 *
 * Read-only. The workspace belongs to the orchestrator skill; this observes it.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ taskCode: string }> }
) {
  const { taskCode } = await context.params
  const run = readRun(taskCode)

  if (!run) {
    // 404 means "no run started", which is a normal state for a delegated task
    // whose agent has not begun — not an error worth alarming about.
    return NextResponse.json({ error: 'no_run' }, { status: 404 })
  }

  return NextResponse.json({
    ...run,
    phaseLabel: phaseLabel(run.currentPhase),
  })
}
