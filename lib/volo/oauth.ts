/**
 * OAuth client for Volo, served by AI Maestro.
 *
 * ## Why this lives in the server rather than in a CLI
 *
 * Volo's authorization server advertises no device endpoint, so the only grant
 * is authorization_code — which needs a redirect the browser can reach. A CLI
 * on the host redirects to `127.0.0.1`, which is the *host's* loopback: when
 * the dashboard is used from another machine (the normal case in a mesh), the
 * browser cannot reach it and the user ends up copying URLs by hand.
 *
 * Serving the flow from AI Maestro puts the redirect on the same origin the
 * user is already browsing, so "Connect" just works from wherever they are.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { getSelfHost } from '@/lib/hosts-config'

export const VOLO_MCP_URL =
  process.env.VOLO_MCP_URL || 'https://mcp.volo.jaak.ai/mcp'

/** Origin of the MCP server, which is also its OAuth issuer. */
export const VOLO_RESOURCE = new URL(VOLO_MCP_URL).origin

/**
 * Only what the panel uses.
 *
 * Volo also exposes members, audit and OKR scopes. A token that can move tasks
 * is a much smaller problem than one that can read the audit log.
 */
export const VOLO_SCOPES = ['tasks:read', 'tasks:write', 'boards:read']

function configDir(): string {
  return path.join(os.homedir(), '.aimaestro', 'volo')
}

function credsPath(): string {
  return path.join(configDir(), 'oauth.json')
}

export interface VoloCredentials {
  clientId: string
  accessToken: string
  refreshToken: string | null
  /** Epoch ms after which the access token must be refreshed. */
  expiresAt: number
  scope: string
}

/** In-flight authorization attempts, keyed by `state`. */
interface PendingAuth {
  verifier: string
  clientId: string
  createdAt: number
  returnTo: string
}

const pending = new Map<string, PendingAuth>()

/** Authorization attempts older than this are abandoned. */
const PENDING_TTL_MS = 10 * 60 * 1000

function prunePending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS
  for (const [state, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(state)
  }
}

// ---------------------------------------------------------------------------
// Credential storage
// ---------------------------------------------------------------------------

export function readCredentials(): VoloCredentials | null {
  try {
    return JSON.parse(fs.readFileSync(credsPath(), 'utf-8')) as VoloCredentials
  } catch {
    return null
  }
}

export function writeCredentials(creds: VoloCredentials): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  // Opened 0600 before anything is written: creating the file world-readable
  // and chmod-ing afterwards leaves a window with the refresh token exposed.
  const fd = fs.openSync(credsPath(), 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(creds, null, 2))
  } finally {
    fs.closeSync(fd)
  }
}

export function clearCredentials(): void {
  try {
    fs.unlinkSync(credsPath())
  } catch {
    /* nothing stored */
  }
}

// ---------------------------------------------------------------------------
// Discovery, registration, PKCE
// ---------------------------------------------------------------------------

interface AuthServerMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
}

export async function authServerMetadata(): Promise<AuthServerMetadata> {
  const res = await fetch(
    `${VOLO_RESOURCE}/.well-known/oauth-authorization-server`
  )
  if (!res.ok) {
    throw new Error(`Volo authorization metadata unavailable (${res.status})`)
  }
  return (await res.json()) as AuthServerMetadata
}

/**
 * The redirect the browser will be sent back to.
 *
 * Built from this host's advertised URL — the same address the dashboard is
 * served on — so it is reachable from wherever the user is browsing.
 */
export function redirectUri(): string {
  const base = (process.env.AIMAESTRO_PUBLIC_URL || getSelfHost().url).replace(
    /\/+$/,
    ''
  )
  return `${base}/api/volo/auth/callback`
}

async function registerClient(meta: AuthServerMetadata): Promise<string> {
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'AI Maestro',
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: VOLO_SCOPES.join(' '),
    }),
  })
  if (!res.ok) {
    throw new Error(`Volo client registration failed (${res.status})`)
  }
  const body = (await res.json()) as { client_id?: string }
  if (!body.client_id) throw new Error('Volo registration returned no client_id')
  return body.client_id
}

const b64url = (buf: Buffer) => buf.toString('base64url')

/**
 * Begin an authorization attempt.
 *
 * Returns the URL the browser must visit. The verifier stays here: PKCE only
 * protects the exchange if it never leaves the server that will redeem it.
 */
export async function beginAuthorization(
  returnTo = '/volo'
): Promise<{ url: string; state: string }> {
  prunePending()

  const meta = await authServerMetadata()
  const existing = readCredentials()
  const clientId = existing?.clientId || (await registerClient(meta))

  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(
    crypto.createHash('sha256').update(verifier).digest()
  )
  const state = b64url(crypto.randomBytes(16))

  pending.set(state, { verifier, clientId, createdAt: Date.now(), returnTo })

  const url = new URL(meta.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('scope', VOLO_SCOPES.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // RFC 8707: binds the token to this MCP server, so a token minted here
  // cannot be replayed against another resource trusting the same issuer.
  url.searchParams.set('resource', VOLO_RESOURCE)

  return { url: url.toString(), state }
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

async function requestToken(
  meta: AuthServerMetadata,
  params: Record<string, string>
): Promise<TokenResponse> {
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const body = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok || !body.access_token) {
    throw new Error(
      body.error_description || body.error || `Token request failed (${res.status})`
    )
  }
  return body
}

function persist(clientId: string, tokens: TokenResponse): VoloCredentials {
  const creds: VoloCredentials = {
    clientId,
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token || readCredentials()?.refreshToken || null,
    // A minute of slack, so a token about to lapse is refreshed rather than
    // sent and rejected.
    expiresAt: Date.now() + Math.max(0, (tokens.expires_in || 3600) - 60) * 1000,
    scope: tokens.scope || VOLO_SCOPES.join(' '),
  }
  writeCredentials(creds)
  return creds
}

/**
 * Complete an authorization attempt.
 *
 * An unknown `state` is rejected: it is either an expired attempt or a code
 * this server never asked for.
 */
export async function completeAuthorization(
  state: string,
  code: string
): Promise<{ returnTo: string }> {
  prunePending()

  const attempt = pending.get(state)
  if (!attempt) {
    throw new Error('Unknown or expired authorization attempt')
  }
  // Single use, whatever happens next.
  pending.delete(state)

  const meta = await authServerMetadata()
  const tokens = await requestToken(meta, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: attempt.clientId,
    code_verifier: attempt.verifier,
    resource: VOLO_RESOURCE,
  })

  persist(attempt.clientId, tokens)
  return { returnTo: attempt.returnTo }
}

/**
 * A usable access token, refreshing if the stored one has lapsed.
 *
 * Returns null when Volo is simply not connected — callers render a "connect"
 * prompt rather than treating it as a failure.
 */
export async function accessToken(): Promise<string | null> {
  const creds = readCredentials()
  if (!creds?.accessToken) return null

  if (Date.now() < creds.expiresAt) return creds.accessToken
  if (!creds.refreshToken) return null

  try {
    const meta = await authServerMetadata()
    const tokens = await requestToken(meta, {
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      resource: VOLO_RESOURCE,
    })
    return persist(creds.clientId, tokens).accessToken
  } catch {
    // A refresh token the server no longer honours means the connection is
    // over; say "not connected" rather than erroring on every page load.
    return null
  }
}

export interface VoloConnectionStatus {
  connected: boolean
  scope?: string
  expiresAt?: number
  /** True when credentials exist but could not be refreshed. */
  expired?: boolean
}

export function connectionStatus(): VoloConnectionStatus {
  const creds = readCredentials()
  if (!creds?.accessToken) return { connected: false }

  const usable = Date.now() < creds.expiresAt || !!creds.refreshToken
  return {
    connected: usable,
    expired: !usable,
    scope: creds.scope,
    expiresAt: creds.expiresAt,
  }
}
