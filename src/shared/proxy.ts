import type { ForwardSet, ServersDoc, SshServer } from './types'

function findSsh(id: string, doc: ServersDoc, role: string): SshServer {
  const s = doc.servers.find((x) => x.id === id)
  if (!s) throw new Error(`${role} server ${JSON.stringify(id)} not found`)
  if (s.type !== 'ssh') throw new Error(`${role} "${s.name}" is not an SSH server`)
  return s
}

function chainToHops(chain: string[], target: SshServer, doc: ServersDoc): SshServer[] {
  const problems = validateServerJumpChain(target.id, chain, doc)
  if (problems.length) throw new Error(problems[0])
  return [...chain.map((id) => findSsh(id, doc, 'Jump')), target]
}

/** Hops for an interactive connection: the server's own jump chain (if enabled) + the server. */
export function resolveServerHops(serverId: string, doc: ServersDoc): SshServer[] {
  const target = findSsh(serverId, doc, 'Target')
  const pj = target.proxyJump
  return chainToHops(pj && pj.enabled ? pj.chain : [], target, doc)
}

/** Hops for a forwarding set (see task.md 4.2 proxyJump rules). */
export function resolveSetHops(set: ForwardSet, doc: ServersDoc): SshServer[] {
  if (!set.server) {
    throw new Error(
      set.unresolvedServer ? `Set has unresolved server "${set.unresolvedServer}"` : 'Set has no target server'
    )
  }
  if (set.proxyJump === undefined) return resolveServerHops(set.server, doc)
  return chainToHops(set.proxyJump, findSsh(set.server, doc, 'Target'), doc)
}

/** Returns human readable problems; empty = valid. */
export function validateServerJumpChain(targetId: string, chain: string[], doc: ServersDoc): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const id of chain) {
    const s = doc.servers.find((x) => x.id === id)
    if (id === targetId) problems.push('A server cannot use itself as a jump host')
    else if (!s) problems.push(`Unknown jump server ${JSON.stringify(id)}`)
    else if (s.type !== 'ssh') problems.push(`Jump host "${s.name}" must be an SSH server`)
    if (seen.has(id)) problems.push(`Jump host "${s?.name ?? id}" appears more than once (cycle)`)
    seen.add(id)
  }
  return problems
}
