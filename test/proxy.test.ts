import { describe, expect, it } from 'vitest'
import { resolveServerHops, resolveSetHops, validateServerJumpChain } from '../src/shared/proxy'
import type { ServersDoc, SshServer } from '../src/shared/types'

const ssh = (id: string, extra: Partial<SshServer> = {}): SshServer => ({
  id,
  type: 'ssh',
  name: id,
  host: `${id}.example`,
  port: 22,
  username: 'u',
  auth: { method: 'auto' },
  ...extra
})

const doc: ServersDoc = {
  folders: [],
  servers: [
    ssh('bastion'),
    ssh('inner'),
    ssh('target', { proxyJump: { enabled: true, chain: ['bastion', 'inner'] } }),
    ssh('off', { proxyJump: { enabled: false, chain: ['bastion'] } }),
    { id: 'sh', type: 'local', name: 'bash', shell: '/bin/bash' }
  ]
}

describe('resolveServerHops', () => {
  it('returns jump chain followed by the target when enabled', () => {
    expect(resolveServerHops('target', doc).map((s) => s.id)).toEqual(['bastion', 'inner', 'target'])
  })
  it('connects directly when the jump switch is off', () => {
    expect(resolveServerHops('off', doc).map((s) => s.id)).toEqual(['off'])
  })
  it('does not resolve jumps of jump hosts recursively', () => {
    const d: ServersDoc = { folders: [], servers: [...doc.servers, ssh('t2', { proxyJump: { enabled: true, chain: ['target'] } })] }
    expect(resolveServerHops('t2', d).map((s) => s.id)).toEqual(['target', 't2'])
  })
  it('throws for unknown or local servers', () => {
    expect(() => resolveServerHops('nope', doc)).toThrow(/not found/)
    expect(() => resolveServerHops('sh', doc)).toThrow(/not an SSH server/)
  })
})

describe('resolveSetHops', () => {
  const base = { id: 's', name: 'S', server: 'target', forwards: [] }
  it('uses the server jump config when proxyJump is absent', () => {
    expect(resolveSetHops(base, doc).map((s) => s.id)).toEqual(['bastion', 'inner', 'target'])
  })
  it('connects directly for an empty list', () => {
    expect(resolveSetHops({ ...base, proxyJump: [] }, doc).map((s) => s.id)).toEqual(['target'])
  })
  it('uses an explicit chain', () => {
    expect(resolveSetHops({ ...base, proxyJump: ['inner'] }, doc).map((s) => s.id)).toEqual(['inner', 'target'])
  })
  it('refuses unresolved target servers', () => {
    expect(() => resolveSetHops({ ...base, server: '', unresolvedServer: 'web' }, doc)).toThrow(/unresolved server "web"/)
  })
})

describe('validateServerJumpChain', () => {
  it('accepts a valid chain', () => {
    expect(validateServerJumpChain('target', ['bastion', 'inner'], doc)).toEqual([])
  })
  it('rejects self references, duplicates (cycles), unknown and local hops', () => {
    expect(validateServerJumpChain('target', ['target'], doc)[0]).toMatch(/itself/)
    expect(validateServerJumpChain('target', ['bastion', 'bastion'], doc)[0]).toMatch(/more than once/)
    expect(validateServerJumpChain('target', ['ghost'], doc)[0]).toMatch(/unknown/i)
    expect(validateServerJumpChain('target', ['sh'], doc)[0]).toMatch(/SSH/)
  })
})
