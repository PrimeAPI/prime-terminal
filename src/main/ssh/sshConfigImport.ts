// One-time import of hosts from an OpenSSH client config (~/.ssh/config).
// Supported: Host (concrete names), HostName, User, Port, IdentityFile, ProxyJump.
// Option lookup follows OpenSSH semantics: blocks are scanned in order, first value wins.

import type { ServersDoc, SshServer } from '../../shared/types'
import { newId } from '../../shared/ids'

interface Block {
  patterns: string[]
  options: Map<string, string>
}

const RELEVANT = new Set(['hostname', 'user', 'port', 'identityfile', 'proxyjump'])

function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re}$`, 'i')
}

function blockMatches(patterns: string[], alias: string): boolean {
  let matched = false
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(alias)) return false
    } else if (globToRegExp(p).test(alias)) matched = true
  }
  return matched
}

const isConcrete = (p: string) => !/[*?!]/.test(p)

function parse(text: string, warnings: string[]): Block[] {
  const blocks: Block[] = [{ patterns: ['*'], options: new Map() }] // options before any Host apply globally
  let current: Block | null = blocks[0]
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      current = { patterns: value.split(/\s+/).filter(Boolean), options: new Map() }
      blocks.push(current)
    } else if (key === 'match') {
      warnings.push(`"Match ${value}" blocks are not supported and were ignored`)
      current = null
    } else if (key === 'include') {
      warnings.push(`"Include ${value}" is not supported and was ignored`)
    } else if (current && RELEVANT.has(key) && !current.options.has(key)) {
      current.options.set(key, value)
    }
  }
  return blocks
}

function lookup(blocks: Block[], alias: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const b of blocks) {
    if (!blockMatches(b.patterns, alias)) continue
    for (const [k, v] of b.options) if (!out.has(k)) out.set(k, v)
  }
  return out
}

function parseJumpSpec(spec: string): { user?: string; host: string; port?: number } {
  const m = /^(?:ssh:\/\/)?(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(spec.trim())
  if (!m) return { host: spec.trim() }
  return { user: m[1], host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : undefined }
}

export interface ImportResult {
  doc: ServersDoc
  added: number
  warnings: string[]
}

export function importSshConfig(text: string, existing: ServersDoc, osUser: string): ImportResult {
  const warnings: string[] = []
  const blocks = parse(text, warnings)
  const doc: ServersDoc = { folders: [...existing.folders], servers: [...existing.servers] }
  let added = 0

  const aliases: string[] = []
  for (const b of blocks.slice(1)) for (const p of b.patterns) if (isConcrete(p) && !aliases.includes(p)) aliases.push(p)

  const findByName = (name: string) => doc.servers.find((s) => s.type === 'ssh' && s.name === name) as SshServer | undefined

  const makeServer = (alias: string): SshServer => {
    const o = lookup(blocks, alias)
    const identity = o.get('identityfile')
    const port = Number(o.get('port') ?? 22)
    return {
      id: newId(),
      type: 'ssh',
      name: alias,
      host: o.get('hostname') ?? alias,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
      username: o.get('user') ?? osUser,
      auth: identity ? { method: 'key', keyPath: identity.replace(/^%d\b/, '~') } : { method: 'auto' }
    }
  }

  const created = new Map<string, SshServer>()
  for (const alias of aliases) {
    if (findByName(alias)) continue
    const s = makeServer(alias)
    doc.servers.push(s)
    created.set(alias, s)
    added++
  }

  // second pass: proxy jumps (needs all aliases to exist)
  for (const [alias, server] of created) {
    const pj = lookup(blocks, alias).get('proxyjump')
    if (!pj || pj.toLowerCase() === 'none') continue
    const chain: string[] = []
    for (const part of pj.split(',')) {
      const spec = parseJumpSpec(part)
      const known = !spec.user && !spec.port ? findByName(spec.host) : undefined
      if (known) {
        chain.push(known.id)
        continue
      }
      const name = `${spec.user ? spec.user + '@' : ''}${spec.host}${spec.port ? ':' + spec.port : ''}`
      let hop = findByName(name)
      if (!hop) {
        const base = makeServer(spec.host)
        hop = { ...base, name, username: spec.user ?? base.username, port: spec.port ?? base.port }
        doc.servers.push(hop)
        added++
      }
      chain.push(hop.id)
    }
    server.proxyJump = { enabled: true, chain }
  }

  return { doc, added, warnings }
}
