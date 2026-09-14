import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Agent } from '@/types/agent'

// getSelfHost reads ~/.aimaestro/hosts.json; stub it so the card builder is
// tested against a known host rather than whatever the machine is configured
// with.
vi.mock('@/lib/hosts-config', () => ({
  getSelfHost: () => ({
    id: 'testhost',
    name: 'testhost',
    url: 'http://10.0.0.5:23000',
  }),
}))

import {
  buildAgentCard,
  agentBaseUrl,
  A2A_PROTOCOL_VERSION,
} from '@/lib/a2a/agent-card'

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'ab12cd34-0000-0000-0000-000000000001',
    name: 'backend-api',
    hostId: 'testhost',
    sessions: [],
    program: 'Claude Code',
    taskDescription: 'Maintains the billing service.',
    ...overrides,
  } as Agent
}

describe('buildAgentCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the agent name and its task description', () => {
    const card = buildAgentCard(makeAgent())
    expect(card.name).toBe('backend-api')
    expect(card.description).toBe('Maintains the billing service.')
  })

  it('prefers the display label over the raw name when set', () => {
    const card = buildAgentCard(makeAgent({ label: 'Billing Bot' }))
    expect(card.name).toBe('Billing Bot')
  })

  it('falls back to a program-based description when none is set', () => {
    const card = buildAgentCard(makeAgent({ taskDescription: '' }))
    expect(card.description).toContain('Claude Code')
  })

  // Tasks are bridged over AMP, which is store-and-forward. A card that
  // claimed streaming would make clients open a stream that never produces
  // incremental events.
  it('does not advertise streaming', () => {
    const card = buildAgentCard(makeAgent())
    expect(card.capabilities?.streaming).toBe(false)
  })

  it('points the interface at the agent host, not the serving host', () => {
    const card = buildAgentCard(
      makeAgent({ hostUrl: 'http://10.0.0.9:23000' })
    )
    expect(card.supportedInterfaces[0].url).toContain('http://10.0.0.9:23000')
    expect(card.supportedInterfaces[0].protocolVersion).toBe(
      A2A_PROTOCOL_VERSION
    )
  })

  it('falls back to this host when the agent has no host URL', () => {
    const card = buildAgentCard(makeAgent({ hostUrl: undefined }))
    expect(card.supportedInterfaces[0].url).toContain('http://10.0.0.5:23000')
  })

  // Advertising a binding that is not routed produces clients that fail on the
  // first call instead of negotiating something that works.
  it('only advertises transports that are actually mounted', () => {
    const card = buildAgentCard(makeAgent())
    expect(card.supportedInterfaces).toHaveLength(1)
    expect(card.supportedInterfaces[0].protocolBinding).toBe('JSONRPC')
  })

  it('exposes exactly one honest general skill', () => {
    const card = buildAgentCard(makeAgent())
    expect(card.skills).toHaveLength(1)
    expect(card.skills[0].id).toBe('general-assistance')
  })

  it('omits iconUrl for emoji avatars, which are not URLs', () => {
    const card = buildAgentCard(makeAgent({ avatar: '🤖' }))
    expect(card.iconUrl).toBeUndefined()
  })

  it('sets iconUrl when the avatar is a real URL', () => {
    const card = buildAgentCard(
      makeAgent({ avatar: 'https://example.com/a.png' })
    )
    expect(card.iconUrl).toBe('https://example.com/a.png')
  })
})

describe('agentBaseUrl', () => {
  it('addresses the agent by id, so renames do not break callers', () => {
    const agent = makeAgent({ hostUrl: 'http://10.0.0.9:23000' })
    expect(agentBaseUrl(agent)).toBe(
      `http://10.0.0.9:23000/api/a2a/agents/${agent.id}`
    )
  })

  it('does not double the slash when the host URL has a trailing one', () => {
    const agent = makeAgent({ hostUrl: 'http://10.0.0.9:23000/' })
    expect(agentBaseUrl(agent)).not.toContain('23000//')
  })
})

describe('security advertised on the card', () => {
  it('advertises no scheme when the server is open', () => {
    const card = buildAgentCard(makeAgent())
    expect(card.securitySchemes).toEqual({})
    expect(card.securityRequirements).toEqual([])
  })

  // A client that is not told a token is needed discovers it by failing the
  // first call. Advertising the scheme turns that into a normal handshake.
  it('advertises bearer when the server requires a token', () => {
    const card = buildAgentCard(makeAgent(), { requiresAuth: true })
    expect(card.securitySchemes.bearer?.scheme?.$case).toBe(
      'httpAuthSecurityScheme'
    )
    expect(card.securityRequirements).toHaveLength(1)
  })
})
