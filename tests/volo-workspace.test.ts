import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ligo-ws-'))
  vi.stubEnv('LIGO_WORKSPACES_ROOT', root)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

function writeRun(taskCode: string, lines: object[]): void {
  const dir = path.join(root, taskCode)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
}

const start = (fase: string, mensaje = 'x') => ({
  ts: '2026-09-14T10:00:00Z',
  fase,
  tipo: 'fase_inicio',
  mensaje,
})
const end = (fase: string, mensaje = 'x') => ({
  ts: '2026-09-14T10:01:00Z',
  fase,
  tipo: 'fase_fin',
  mensaje,
})

describe('readRun', () => {
  it('returns null when no workspace exists', async () => {
    const { readRun } = await import('@/lib/volo/workspace')
    expect(readRun('NOPE-1')).toBeNull()
  })

  // The skill writes fase_inicio before doing any work, so an unclosed phase
  // is what the agent is doing now — not what it last finished.
  it('reports the open phase as current', async () => {
    writeRun('TO-1', [start('pre_vuelo'), end('pre_vuelo'), start('plan')])
    const { readRun } = await import('@/lib/volo/workspace')
    expect(readRun('TO-1')?.currentPhase).toBe('plan')
  })

  it('reports no current phase once everything closed', async () => {
    writeRun('TO-2', [start('handoff'), end('handoff')])
    const { readRun } = await import('@/lib/volo/workspace')
    expect(readRun('TO-2')?.currentPhase).toBeNull()
  })

  it('collects completed phases', async () => {
    writeRun('TO-3', [
      start('pre_vuelo'),
      end('pre_vuelo'),
      start('entrada_volo'),
      end('entrada_volo'),
      start('plan'),
    ])
    const { readRun } = await import('@/lib/volo/workspace')
    expect(readRun('TO-3')?.phasesCompleted).toEqual([
      'pre_vuelo',
      'entrada_volo',
    ])
  })

  // A run parked on a checkpoint is blocked on a person, not progressing.
  // Showing it as "working" hides that nothing happens until they answer.
  it('flags a human checkpoint', async () => {
    writeRun('TO-4', [start('checkpoint_1')])
    const { readRun } = await import('@/lib/volo/workspace')
    expect(readRun('TO-4')?.awaitingHuman).toBe(true)
  })

  it('does not flag an ordinary phase as awaiting a human', async () => {
    writeRun('TO-5', [start('construccion')])
    const { readRun } = await import('@/lib/volo/workspace')
    expect(readRun('TO-5')?.awaitingHuman).toBe(false)
  })

  // The log is appended to by a live process, so a truncated last line is
  // normal and must not fail the read.
  it('skips malformed lines instead of failing', async () => {
    const dir = path.join(root, 'TO-6')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'events.jsonl'),
      `${JSON.stringify(start('plan'))}\n{"ts":"broken`
    )
    const { readRun } = await import('@/lib/volo/workspace')
    expect(readRun('TO-6')?.currentPhase).toBe('plan')
  })

  it('handles a workspace with no event log yet', async () => {
    fs.mkdirSync(path.join(root, 'TO-7'), { recursive: true })
    const { readRun } = await import('@/lib/volo/workspace')
    const run = readRun('TO-7')
    expect(run?.currentPhase).toBeNull()
    expect(run?.eventCount).toBe(0)
  })

  // Task codes build a filesystem path, so traversal must not escape the root.
  it('refuses a traversing task code', async () => {
    const { readRun } = await import('@/lib/volo/workspace')
    expect(readRun('../../etc')).toBeNull()
  })

  it('keeps the last events for a timeline', async () => {
    writeRun(
      'TO-8',
      Array.from({ length: 20 }, (_, i) => start(`fase_${i}`))
    )
    const { readRun } = await import('@/lib/volo/workspace')
    const run = readRun('TO-8')
    expect(run?.eventCount).toBe(20)
    expect(run?.recent).toHaveLength(8)
    expect(run?.recent.at(-1)?.fase).toBe('fase_19')
  })
})

describe('phaseLabel', () => {
  it('translates a known phase', async () => {
    const { phaseLabel } = await import('@/lib/volo/workspace')
    expect(phaseLabel('analisis_preliminar')).toBe('Análisis preliminar')
  })

  // A phase the skill added after this map was written must still render.
  it('falls back to a readable form for unknown phases', async () => {
    const { phaseLabel } = await import('@/lib/volo/workspace')
    expect(phaseLabel('fase_nueva_del_skill')).toBe('fase nueva del skill')
  })

  it('returns null for no phase', async () => {
    const { phaseLabel } = await import('@/lib/volo/workspace')
    expect(phaseLabel(null)).toBeNull()
  })
})

describe('listRuns', () => {
  it('lists workspaces', async () => {
    writeRun('TO-10', [start('plan')])
    writeRun('TO-11', [start('plan')])
    const { listRuns } = await import('@/lib/volo/workspace')
    expect(listRuns().sort()).toEqual(['TO-10', 'TO-11'])
  })

  it('returns nothing when the root does not exist', async () => {
    vi.stubEnv('LIGO_WORKSPACES_ROOT', path.join(root, 'missing'))
    const { listRuns } = await import('@/lib/volo/workspace')
    expect(listRuns()).toEqual([])
  })
})
