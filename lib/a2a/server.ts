/**
 * Wiring for the A2A server.
 *
 * Builds the per-agent request handler from the pieces: the agent's card, the
 * on-disk task store, and the AMP-bridging executor. Kept separate from the
 * route so the assembly can be tested without an HTTP layer.
 */

import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
} from '@a2a-js/sdk/server'
import type { Agent } from '@/types/agent'
import { buildAgentCard } from '@/lib/a2a/agent-card'
import { AmpBridgeExecutor } from '@/lib/a2a/executor'
import { FileTaskStore } from '@/lib/a2a/task-store'
import { loadAuthConfig, type A2AAuthConfig } from '@/lib/a2a/auth'

/**
 * One store for every agent on this host.
 *
 * Task ids are unique across agents, so a single directory is enough and it
 * keeps `list` able to answer across agents without walking per-agent folders.
 */
let sharedStore: FileTaskStore | null = null

function store(): FileTaskStore {
  if (!sharedStore) sharedStore = new FileTaskStore()
  return sharedStore
}

export interface A2AServerPieces {
  card: ReturnType<typeof buildAgentCard>
  handler: DefaultRequestHandler
  transport: JsonRpcTransportHandler
}

/**
 * Build everything needed to serve one agent over A2A.
 *
 * `requiresAuth` is passed through to the card so what it advertises always
 * matches what the route enforces — a card that omitted the scheme while the
 * route rejected unauthenticated calls would send clients into a 401 they
 * could not have anticipated.
 */
export function buildServerFor(
  agent: Agent,
  config: A2AAuthConfig = loadAuthConfig()
): A2AServerPieces {
  const card = buildAgentCard(agent, { requiresAuth: config.enabled })

  const executor = new AmpBridgeExecutor({
    // Address the agent by id: names and aliases can be changed by the
    // operator, and a task in flight must not start resolving elsewhere.
    agentIdentifier: agent.id,
    // The executor answers the request immediately and finishes waiting for
    // the agent in the background, so it needs the store to record the
    // outcome once the event bus is gone.
    taskStore: store(),
  })

  const handler = new DefaultRequestHandler(card, store(), executor)

  return {
    card,
    handler,
    transport: new JsonRpcTransportHandler(handler),
  }
}
