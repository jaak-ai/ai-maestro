import { NextRequest, NextResponse } from 'next/server'
import { getAgent } from '@/lib/agent-registry'
import { buildServerFor } from '@/lib/a2a/server'
import {
  authenticate,
  loadAuthConfig,
  WWW_AUTHENTICATE,
} from '@/lib/a2a/auth'

/**
 * A2A protocol endpoint for a single agent.
 *
 *   GET  /api/a2a/agents/:id/.well-known/agent-card.json  → the Agent Card
 *   POST /api/a2a/agents/:id                              → JSON-RPC
 *
 * A catch-all is used because Next.js ignores directories whose name starts
 * with a dot, so `.well-known` cannot be a folder in the App Router.
 *
 * ## Closed by default
 *
 * Every method returns 404 while A2A is disabled — not 401. A 401 confirms
 * that this host runs AI Maestro and has agents worth probing; 404 is what an
 * endpoint that does not exist returns, which is the truth when the feature is
 * off. See lib/a2a/auth.ts for why the default is off.
 */

export const dynamic = 'force-dynamic'

const CARD_PATH = '.well-known/agent-card.json'

/** Indistinguishable from a route that does not exist. */
function notFound(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 })
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'WWW-Authenticate': WWW_AUTHENTICATE } }
  )
}

interface RouteContext {
  params: Promise<{ id: string; path?: string[] }>
}

/**
 * Resolve the request to an agent, enforcing auth first.
 *
 * Auth is checked BEFORE the agent lookup so an unauthenticated caller cannot
 * use response differences to discover which agent ids exist.
 */
async function resolve(request: NextRequest, context: RouteContext) {
  const config = loadAuthConfig()
  if (!config.enabled) return { error: notFound() }

  const auth = authenticate(request.headers.get('authorization'), config)
  if (!auth.ok) return { error: unauthorized() }

  const { id, path } = await context.params
  const agent = getAgent(id)
  if (!agent) return { error: notFound() }

  return { agent, config, callerId: auth.callerId, path: (path || []).join('/') }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const resolved = await resolve(request, context)
  if ('error' in resolved) return resolved.error

  if (resolved.path !== CARD_PATH) return notFound()

  const { card } = buildServerFor(resolved.agent!, resolved.config!)
  return NextResponse.json(card)
}

export async function POST(request: NextRequest, context: RouteContext) {
  const resolved = await resolve(request, context)
  if ('error' in resolved) return resolved.error

  // JSON-RPC is served at the agent root only; a POST to any sub-path is a
  // client that has built the wrong URL.
  if (resolved.path) return notFound()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      { status: 400 }
    )
  }

  const { transport } = buildServerFor(resolved.agent!, resolved.config!)

  try {
    const result = await transport.handle(
      body as Record<string, unknown>,
      // The SDK's context carries the authenticated caller. The opaque caller
      // id is passed rather than the token, which must never leave auth.ts.
      { user: { username: resolved.callerId ?? 'a2a' } } as never
    )

    // Streaming methods return an async generator. This deployment does not
    // advertise streaming on the card, so a client should not reach here —
    // answer honestly instead of hanging on a stream nobody will read.
    if (result && typeof (result as AsyncGenerator).next === 'function') {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          id: (body as { id?: unknown })?.id ?? null,
          error: {
            code: -32004,
            message:
              'Streaming is not supported by this agent. Tasks are delivered asynchronously; poll GetTask instead.',
          },
        },
        { status: 400 }
      )
    }

    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: (body as { id?: unknown })?.id ?? null,
        error: { code: -32603, message: (err as Error).message },
      },
      { status: 500 }
    )
  }
}
