/**
 * A2A Agent Card generation
 *
 * Builds an Agent2Agent (A2A) v1.0 Agent Card from an AI Maestro registry
 * agent, so external systems can discover what an agent is and how to reach it
 * without knowing anything about AI Maestro's own API.
 *
 * One card per agent — not one aggregate card for the host. An external caller
 * discovers and invokes the specific agent it needs.
 *
 * Spec: https://a2a-protocol.org/v1.0.0/specification/
 */

import type {
  AgentCard,
  AgentInterface,
  AgentSkill,
} from '@a2a-js/sdk'
import type { Agent } from '@/types/agent'
import { getSelfHost } from '@/lib/hosts-config'

/** Protocol version this server implements. */
export const A2A_PROTOCOL_VERSION = '1.0'

/** Path prefix every A2A route lives under. */
export const A2A_BASE_PATH = '/api/a2a'

/**
 * Tasks are bridged to AMP, which is store-and-forward: the agent may be
 * offline when the task arrives and answer minutes later. That rules out
 * live streaming, so the card must not claim it — a client that believes
 * `streaming: true` will open a stream that never produces incremental events.
 *
 * Push notifications are the honest alternative for this shape and are
 * advertised once the webhook sender is wired (see pendientes.md).
 */
const SUPPORTS_STREAMING = false
const SUPPORTS_PUSH_NOTIFICATIONS = false

/**
 * Base URL for an agent's A2A endpoints.
 *
 * Uses the agent's own host URL so a card fetched from any node of the mesh
 * points at the node that actually runs the agent, not at whoever served the
 * card. Falls back to this host when the registry has no URL for it.
 */
export function agentBaseUrl(agent: Agent): string {
  const hostUrl = agent.hostUrl || getSelfHost().url
  return `${hostUrl.replace(/\/+$/, '')}${A2A_BASE_PATH}/agents/${agent.id}`
}

/**
 * Human-readable description for the card.
 *
 * `taskDescription` is what the operator wrote about what this agent is for,
 * which is the closest thing the registry has to a capability statement.
 */
function describeAgent(agent: Agent): string {
  const described = agent.taskDescription?.trim()
  if (described) return described

  const program = agent.program?.trim()
  return program
    ? `AI Maestro agent running ${program}.`
    : 'AI Maestro agent.'
}

/**
 * Skills advertised by the agent.
 *
 * AI Maestro has no per-agent skill catalogue: an agent is a general-purpose
 * assistant sitting in a terminal. Advertising one honest general skill beats
 * inventing a taxonomy the agent has never agreed to, which would make
 * capability-based routing pick this agent for work it cannot do.
 */
function buildSkills(agent: Agent): AgentSkill[] {
  const tags = ['ai-maestro', 'general']
  if (agent.program) tags.push(agent.program.toLowerCase().replace(/\s+/g, '-'))

  return [
    {
      id: 'general-assistance',
      name: 'General assistance',
      description: describeAgent(agent),
      tags,
      examples: [],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: [],
    },
  ]
}

/**
 * Transport interfaces this server exposes for the agent.
 *
 * JSON-RPC only for now. REST and gRPC are supported by the SDK against the
 * same request handler and can be added here once they are actually mounted —
 * advertising a binding that is not routed produces clients that fail at the
 * first call rather than falling back.
 */
function buildInterfaces(agent: Agent): AgentInterface[] {
  return [
    {
      url: agentBaseUrl(agent),
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ]
}

export interface BuildAgentCardOptions {
  /**
   * Whether the server requires a bearer token. When true the card advertises
   * the scheme so a client knows to present credentials instead of discovering
   * it through a 401 on the first call.
   */
  requiresAuth?: boolean
  /** Version string for the card. Defaults to the AI Maestro app version. */
  version?: string
  /** Organization to advertise as the provider. */
  organization?: string
  /** Provider URL. Defaults to the agent's host URL. */
  providerUrl?: string
}

/**
 * Build the A2A Agent Card for a registry agent.
 *
 * The card is unsigned here. Signing reuses the Ed25519 keypair AMP already
 * generates per agent (`agent.ampIdentity`) rather than introducing a second
 * identity model, and is applied by the caller that has key access.
 */
export function buildAgentCard(
  agent: Agent,
  options: BuildAgentCardOptions = {}
): AgentCard {
  const providerUrl =
    options.providerUrl || agent.hostUrl || getSelfHost().url

  return {
    name: agent.label?.trim() || agent.name,
    description: describeAgent(agent),
    supportedInterfaces: buildInterfaces(agent),
    provider: {
      organization: options.organization || 'AI Maestro',
      url: providerUrl,
    },
    version: options.version || '1.0.0',
    capabilities: {
      streaming: SUPPORTS_STREAMING,
      pushNotifications: SUPPORTS_PUSH_NOTIFICATIONS,
      extensions: [],
    },
    ...(options.requiresAuth
      ? {
          securitySchemes: {
            bearer: {
              scheme: {
                $case: 'httpAuthSecurityScheme' as const,
                value: {
                  description: 'AI Maestro A2A bearer token',
                  scheme: 'bearer',
                  bearerFormat: 'opaque',
                },
              },
            },
          },
          securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        }
      : { securitySchemes: {}, securityRequirements: [] }),
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: buildSkills(agent),
    signatures: [],
    ...(agent.avatar && /^https?:\/\//.test(agent.avatar)
      ? { iconUrl: agent.avatar }
      : {}),
  }
}
