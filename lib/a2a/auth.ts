/**
 * Authentication for the A2A server.
 *
 * ## Why this exists before the transport is mounted
 *
 * AI Maestro's security model is Phase 1: localhost only, no authentication,
 * because the only client is the person sitting at the machine. A2A breaks that
 * assumption — it is a door into an agent's inbox reachable from anywhere the
 * process is routable, and AI Maestro has no messaging policy behind it yet
 * (the `AgentRole` / closed-team types exist in `types/` but nothing enforces
 * them). An unauthenticated A2A endpoint is therefore remote code execution by
 * proxy: whoever reaches it can task any agent in the mesh.
 *
 * So the A2A server is **off by default** and refuses to run without tokens.
 * Turning it on is a deliberate act, not a side effect of upgrading.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

/** Where tokens live when not supplied through the environment. */
export function authConfigPath(): string {
  return path.join(os.homedir(), '.aimaestro', 'a2a', 'tokens.json')
}

export interface A2AAuthConfig {
  /** Whether the A2A server should serve at all. */
  enabled: boolean
  /** Accepted bearer tokens. Empty means nothing can authenticate. */
  tokens: string[]
}

interface StoredTokens {
  enabled?: boolean
  tokens?: Array<string | { token?: string; label?: string }>
}

/**
 * Load the A2A auth configuration.
 *
 * `AIMAESTRO_A2A_TOKENS` (comma-separated) overrides the file, for deployments
 * that inject secrets as environment variables. Absent both, the server is off.
 */
export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = authConfigPath()
): A2AAuthConfig {
  const fromEnv = (env.AIMAESTRO_A2A_TOKENS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  if (fromEnv.length > 0) {
    return { enabled: true, tokens: fromEnv }
  }

  let stored: StoredTokens
  try {
    stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as StoredTokens
  } catch {
    // No config at all is the default state: A2A stays off.
    return { enabled: false, tokens: [] }
  }

  const tokens = (stored.tokens || [])
    .map((t) => (typeof t === 'string' ? t : t?.token))
    .map((t) => (t || '').trim())
    .filter(Boolean)

  // `enabled: true` with no tokens is a misconfiguration that would otherwise
  // serve an open endpoint. Treat it as off rather than as "allow everyone".
  return {
    enabled: stored.enabled === true && tokens.length > 0,
    tokens,
  }
}

/** Reason a request was rejected, for logging. Never sent to the caller. */
export type AuthFailure = 'disabled' | 'missing' | 'malformed' | 'unknown-token'

export interface AuthResult {
  ok: boolean
  failure?: AuthFailure
  /**
   * Stable, non-reversible id of the accepted token, so a caller can be
   * attributed in logs and in the AMP sender without the token itself ever
   * being written anywhere.
   */
  callerId?: string
}

/**
 * Compare in constant time.
 *
 * A plain `===` on secrets leaks their prefix length through timing. The
 * lengths are compared first because `timingSafeEqual` throws on a mismatch,
 * and that length check is not itself secret.
 */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** Short, stable pseudonym for a token. Not reversible to the token. */
export function callerIdFor(token: string): string {
  return `a2a-${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`
}

/**
 * Authenticate an incoming A2A request from its Authorization header.
 *
 * Returns only whether it passed and an opaque caller id — never which token
 * matched, and never an error body distinguishing "no such token" from
 * "malformed", which would let an attacker probe the token space.
 */
export function authenticate(
  authorizationHeader: string | null | undefined,
  config: A2AAuthConfig
): AuthResult {
  if (!config.enabled || config.tokens.length === 0) {
    return { ok: false, failure: 'disabled' }
  }

  if (!authorizationHeader) {
    return { ok: false, failure: 'missing' }
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim())
  if (!match) {
    return { ok: false, failure: 'malformed' }
  }

  const presented = match[1].trim()
  if (!presented) return { ok: false, failure: 'malformed' }

  // Compare against every token rather than breaking early, so the time taken
  // does not reveal the position of a match in the list.
  let matched: string | null = null
  for (const known of config.tokens) {
    if (secretEquals(presented, known)) matched = known
  }

  if (!matched) return { ok: false, failure: 'unknown-token' }

  return { ok: true, callerId: callerIdFor(matched) }
}

/**
 * The `WWW-Authenticate` value for a rejected request.
 *
 * Deliberately minimal: naming the realm is enough for a client to know what
 * to present, and anything more describes the deployment to an attacker.
 */
export const WWW_AUTHENTICATE = 'Bearer realm="ai-maestro-a2a"'
