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

describe('artifacts', () => {
  function makeWorkspace(taskCode: string) {
    const dir = path.join(root, taskCode)
    fs.mkdirSync(path.join(dir, 'diseno'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'repos', 'jaak-api'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.md'), '# bitácora')
    fs.writeFileSync(path.join(dir, 'diseno', 'plan.md'), '# el plan\ncuerpo')
    fs.writeFileSync(path.join(dir, 'repos', 'jaak-api', 'README.md'), 'no')
    return dir
  }

  it('lists artifacts with their category', async () => {
    makeWorkspace('TO-20')
    const { listArtifacts } = await import('@/lib/volo/workspace')
    const found = listArtifacts('TO-20')
    expect(found.map((a) => a.path).sort()).toEqual([
      'diseno/plan.md',
      'session.md',
    ])
    expect(found.find((a) => a.name === 'plan.md')?.category).toBe('Diseño')
  })

  // repos/ holds full git clones; walking them would turn a listing into a
  // crawl of an entire codebase.
  it('does not walk into repos/', async () => {
    makeWorkspace('TO-21')
    const { listArtifacts } = await import('@/lib/volo/workspace')
    expect(
      listArtifacts('TO-21').some((a) => a.path.includes('repos'))
    ).toBe(false)
  })

  it('reads an artifact', async () => {
    makeWorkspace('TO-22')
    const { readArtifact } = await import('@/lib/volo/workspace')
    expect(readArtifact('TO-22', 'diseno/plan.md')?.content).toContain('el plan')
  })

  it('returns null for a missing artifact', async () => {
    makeWorkspace('TO-23')
    const { readArtifact } = await import('@/lib/volo/workspace')
    expect(readArtifact('TO-23', 'diseno/nope.md')).toBeNull()
  })

  // The path arrives from a URL, so it must not be able to read outside the
  // workspace.
  it('refuses a traversing artifact path', async () => {
    makeWorkspace('TO-24')
    fs.writeFileSync(path.join(root, 'secreto.md'), 'no deberías verme')
    const { readArtifact } = await import('@/lib/volo/workspace')
    expect(readArtifact('TO-24', '../secreto.md')).toBeNull()
    expect(readArtifact('TO-24', '../../etc/passwd')).toBeNull()
  })

  // path.resolve trabaja sobre el texto de la ruta: un enlace simbolico creado
  // DENTRO del workspace y apuntando fuera pasa la comprobacion de prefijo y
  // openSync lo sigue igual. Los workspaces los escriben agentes que clonan
  // repositorios, asi que el enlace no tiene que ponerlo un atacante.
  it('refuses a symlink that points outside the workspace', async () => {
    const dir = makeWorkspace('TO-27')
    fs.writeFileSync(path.join(root, 'secreto.md'), 'no deberias verme')
    const link = path.join(dir, 'diseno', 'fuga.md')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(path.join(root, 'secreto.md'), link)

    const { readArtifact } = await import('@/lib/volo/workspace')
    expect(readArtifact('TO-27', 'diseno/fuga.md')).toBeNull()
  })

  it('refuses a symlinked directory that escapes', async () => {
    const dir = makeWorkspace('TO-28')
    const fuera = path.join(root, 'fuera')
    fs.mkdirSync(fuera, { recursive: true })
    fs.writeFileSync(path.join(fuera, 'secreto.md'), 'no deberias verme')
    fs.symlinkSync(fuera, path.join(dir, 'atajo'))

    const { readArtifact } = await import('@/lib/volo/workspace')
    expect(readArtifact('TO-28', 'atajo/secreto.md')).toBeNull()
  })

  // El taskCode tambien llega de una URL y elige la RAIZ. El regex de
  // findWorkspace acepta "..", asi que path.join(root, "..") devolvia el
  // directorio padre como workspace y todo lo que colgara de el quedaba
  // "dentro": la comprobacion de contencion se hacia contra una raiz que
  // elegia quien llamaba.
  it('refuses a task code that walks out of the workspace root', async () => {
    const fuera = path.dirname(root)
    const secreto = path.join(fuera, `secreto-${path.basename(root)}.md`)
    fs.writeFileSync(secreto, 'no deberias verme')
    try {
      const { readArtifact, findWorkspace } = await import('@/lib/volo/workspace')
      expect(findWorkspace('..')).toBeNull()
      expect(readArtifact('..', path.basename(secreto))).toBeNull()
    } finally {
      fs.rmSync(secreto, { force: true })
    }
  })

  it('refuses task codes that are only dots or start with a separator-ish char', async () => {
    const { findWorkspace } = await import('@/lib/volo/workspace')
    for (const code of ['.', '..', '...', '-rf', '.oculto']) {
      expect(findWorkspace(code)).toBeNull()
    }
  })

  // La contencion sola no bastaba: `root` se deriva del taskCode, que tambien
  // llega de la URL, asi que se comparaba un valor del usuario contra una raiz
  // elegida por el usuario. La lista blanca valida cada parametro por su
  // cuenta y rompe esa dependencia.
  it('refuses path segments outside the allowlist', async () => {
    makeWorkspace('TO-29')
    const { readArtifact } = await import('@/lib/volo/workspace')
    for (const malo of [
      '../secreto.md',          // traversal clasico
      'diseno/../../secreto.md',// traversal en medio
      '.oculto',                // nombre oculto
      'diseno//plan.md',        // segmento vacio
      'diseno/.../plan.md',     // solo puntos
      '..\\secreto.md',          // separador de Windows
      '-rf/plan.md',            // empieza por guion
    ]) {
      expect(readArtifact('TO-29', malo), malo).toBeNull()
    }
  })

  it('still reads the legitimate artifact paths', async () => {
    makeWorkspace('TO-30')
    const { readArtifact } = await import('@/lib/volo/workspace')
    expect(readArtifact('TO-30', 'session.md')?.content).toContain('bitácora')
    expect(readArtifact('TO-30', 'diseno/plan.md')?.content).toContain('el plan')
  })

  it('refuses an absolute artifact path', async () => {
    makeWorkspace('TO-25')
    const { readArtifact } = await import('@/lib/volo/workspace')
    expect(readArtifact('TO-25', '/etc/passwd')).toBeNull()
  })

  it('reports truncation on a large artifact', async () => {
    const dir = path.join(root, 'TO-26', 'diseno')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plan.md'), 'x'.repeat(600 * 1024))
    const { readArtifact } = await import('@/lib/volo/workspace')
    const read = readArtifact('TO-26', 'diseno/plan.md')
    expect(read?.truncated).toBe(true)
    expect(read!.content.length).toBeLessThan(600 * 1024)
  })
})
