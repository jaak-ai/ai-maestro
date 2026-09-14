import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  authenticate,
  callerIdFor,
  loadAuthConfig,
  type A2AAuthConfig,
} from '@/lib/a2a/auth'

let dir: string
let cfgPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-auth-'))
  cfgPath = path.join(dir, 'tokens.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const enabled = (...tokens: string[]): A2AAuthConfig => ({
  enabled: true,
  tokens,
})

describe('loadAuthConfig', () => {
  // The default must be off. A2A is a door into agent inboxes and AI Maestro
  // has no messaging policy behind it; enabling it has to be deliberate.
  it('is disabled when nothing is configured', () => {
    const cfg = loadAuthConfig({}, path.join(dir, 'missing.json'))
    expect(cfg.enabled).toBe(false)
    expect(cfg.tokens).toEqual([])
  })

  it('reads tokens from the environment', () => {
    const cfg = loadAuthConfig(
      { AIMAESTRO_A2A_TOKENS: 'aaa, bbb ' },
      path.join(dir, 'missing.json')
    )
    expect(cfg.enabled).toBe(true)
    expect(cfg.tokens).toEqual(['aaa', 'bbb'])
  })

  it('reads tokens from the config file', () => {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ enabled: true, tokens: ['filetoken'] })
    )
    expect(loadAuthConfig({}, cfgPath).tokens).toEqual(['filetoken'])
  })

  it('accepts labelled token objects', () => {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        enabled: true,
        tokens: [{ token: 'abc', label: 'ci' }],
      })
    )
    expect(loadAuthConfig({}, cfgPath).tokens).toEqual(['abc'])
  })

  // enabled:true with no tokens would otherwise serve an open endpoint.
  it('stays disabled when enabled is true but no tokens are set', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ enabled: true, tokens: [] }))
    expect(loadAuthConfig({}, cfgPath).enabled).toBe(false)
  })

  it('stays disabled when the file has tokens but enabled is not set', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ tokens: ['abc'] }))
    expect(loadAuthConfig({}, cfgPath).enabled).toBe(false)
  })

  it('treats a corrupt config as disabled rather than throwing', () => {
    fs.writeFileSync(cfgPath, 'not json at all')
    expect(loadAuthConfig({}, cfgPath).enabled).toBe(false)
  })
})

describe('authenticate', () => {
  it('accepts a valid bearer token', () => {
    const res = authenticate('Bearer secret1', enabled('secret1'))
    expect(res.ok).toBe(true)
    expect(res.callerId).toBe(callerIdFor('secret1'))
  })

  it('accepts a token that is not the first in the list', () => {
    expect(authenticate('Bearer s2', enabled('s1', 's2')).ok).toBe(true)
  })

  it('is case-insensitive on the Bearer keyword', () => {
    expect(authenticate('bearer secret1', enabled('secret1')).ok).toBe(true)
  })

  it('rejects when no header is present', () => {
    const res = authenticate(undefined, enabled('secret1'))
    expect(res.ok).toBe(false)
    expect(res.failure).toBe('missing')
  })

  it('rejects a non-bearer scheme', () => {
    expect(authenticate('Basic abc', enabled('abc')).failure).toBe('malformed')
  })

  it('rejects an unknown token', () => {
    expect(authenticate('Bearer nope', enabled('secret1')).failure).toBe(
      'unknown-token'
    )
  })

  // The critical one: a disabled server must reject even a token that would
  // otherwise be valid, rather than falling open.
  it('rejects everything when disabled', () => {
    const res = authenticate('Bearer secret1', {
      enabled: false,
      tokens: ['secret1'],
    })
    expect(res.ok).toBe(false)
    expect(res.failure).toBe('disabled')
  })

  it('rejects when the token list is empty', () => {
    expect(authenticate('Bearer anything', enabled()).ok).toBe(false)
  })

  it('does not accept a prefix of a valid token', () => {
    expect(authenticate('Bearer secret', enabled('secret1')).ok).toBe(false)
  })

  it('never returns the token itself', () => {
    const res = authenticate('Bearer secret1', enabled('secret1'))
    expect(JSON.stringify(res)).not.toContain('secret1')
  })
})

describe('callerIdFor', () => {
  it('is stable for the same token', () => {
    expect(callerIdFor('abc')).toBe(callerIdFor('abc'))
  })

  it('differs between tokens', () => {
    expect(callerIdFor('abc')).not.toBe(callerIdFor('abd'))
  })

  it('does not embed the token', () => {
    expect(callerIdFor('supersecret')).not.toContain('supersecret')
  })
})
