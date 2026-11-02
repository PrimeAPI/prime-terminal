// Portable JSON format for forwarding sets and entries (clipboard, export/import, JSON view).
// Server references are written as server *names*; on import they are resolved by id first, then name.

import type { ForwardEntry, ForwardSet, ForwardType, ServersDoc } from './types'
import { newId } from './ids'

export interface ExchangeEntry {
  name?: string
  type: ForwardType
  enabled?: boolean
  bindAddress?: string
  bindPort: number
  targetHost?: string
  targetPort?: number
}

export interface ExchangeSet {
  name: string
  server: string
  proxyJump?: string[]
  autoStart?: boolean
  forwards: ExchangeEntry[]
}

const serverName = (id: string, servers: ServersDoc) => servers.servers.find((s) => s.id === id)?.name ?? id

export function toExchangeEntry(e: ForwardEntry): ExchangeEntry {
  return {
    ...(e.name ? { name: e.name } : {}),
    type: e.type,
    enabled: e.enabled,
    ...(e.bindAddress ? { bindAddress: e.bindAddress } : {}),
    bindPort: e.bindPort,
    ...(e.type !== 'dynamic' && e.targetHost !== undefined ? { targetHost: e.targetHost } : {}),
    ...(e.type !== 'dynamic' && e.targetPort !== undefined ? { targetPort: e.targetPort } : {})
  }
}

/** Pretty JSON of a set in the exchange format (JSON view, clipboard). */
export function exchangeSetJson(set: ForwardSet, servers: ServersDoc): string {
  return JSON.stringify(toExchangeSet(set, servers), null, 2)
}

export function toExchangeSet(set: ForwardSet, servers: ServersDoc): ExchangeSet {
  return {
    name: set.name,
    server: set.server ? serverName(set.server, servers) : (set.unresolvedServer ?? ''),
    ...(set.proxyJump ? { proxyJump: set.proxyJump.map((id) => serverName(id, servers)) } : {}),
    ...(set.autoStart ? { autoStart: true } : {}),
    forwards: set.forwards.map(toExchangeEntry)
  }
}

/** Resolve a reference (id or name) to a server id, or null. */
export function resolveServerRef(ref: string, servers: ServersDoc): string | null {
  const byId = servers.servers.find((s) => s.id === ref)
  if (byId) return byId.id
  const byName = servers.servers.find((s) => s.type === 'ssh' && s.name === ref)
  return byName ? byName.id : null
}

export function fromExchangeEntry(x: ExchangeEntry): ForwardEntry {
  const e: ForwardEntry = {
    id: newId(),
    type: x.type,
    enabled: x.enabled !== false,
    bindAddress: x.bindAddress || '127.0.0.1',
    bindPort: x.bindPort
  }
  if (x.name) e.name = x.name
  if (x.type !== 'dynamic') {
    e.targetHost = x.targetHost ?? ''
    if (x.targetPort !== undefined) e.targetPort = x.targetPort
  }
  return e
}

export function fromExchangeSet(x: ExchangeSet, servers: ServersDoc): ForwardSet {
  const resolved = x.server ? resolveServerRef(x.server, servers) : null
  const set: ForwardSet = {
    id: newId(),
    name: x.name,
    server: resolved ?? '',
    forwards: (x.forwards ?? []).map(fromExchangeEntry)
  }
  if (!resolved && x.server) set.unresolvedServer = x.server
  if (x.proxyJump) set.proxyJump = x.proxyJump.map((r) => resolveServerRef(r, servers) ?? r)
  if (x.autoStart) set.autoStart = true
  return set
}

// ---- structural checks ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function entryProblem(v: unknown, path: string): string | null {
  if (!isObj(v)) return `${path} must be an object`
  if (!['local', 'remote', 'dynamic'].includes(v.type as string))
    return `${path}.type must be "local", "remote" or "dynamic"`
  if (typeof v.bindPort !== 'number') return `${path}.bindPort must be a number`
  if (v.targetPort !== undefined && typeof v.targetPort !== 'number') return `${path}.targetPort must be a number`
  for (const k of ['name', 'bindAddress', 'targetHost'] as const) {
    if (v[k] !== undefined && typeof v[k] !== 'string') return `${path}.${k} must be a string`
  }
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return `${path}.enabled must be true or false`
  return null
}

function setProblem(v: unknown, path = 'set'): string | null {
  if (!isObj(v)) return `${path} must be an object`
  if (typeof v.name !== 'string') return `${path}.name must be a string`
  if (typeof v.server !== 'string') return `${path}.server must be a server name`
  if (v.proxyJump !== undefined && (!Array.isArray(v.proxyJump) || v.proxyJump.some((p) => typeof p !== 'string')))
    return `${path}.proxyJump must be a list of server names`
  if (v.autoStart !== undefined && typeof v.autoStart !== 'boolean') return `${path}.autoStart must be true or false`
  if (!Array.isArray(v.forwards)) return `${path}.forwards must be a list`
  for (let i = 0; i < v.forwards.length; i++) {
    const p = entryProblem(v.forwards[i], `${path}.forwards[${i}]`)
    if (p) return p
  }
  return null
}

const looksLikeSet = (v: unknown) => isObj(v) && Array.isArray(v.forwards)
const looksLikeEntry = (v: unknown) => isObj(v) && typeof v.type === 'string' && 'bindPort' in v

export type ClipboardContent = { kind: 'sets'; sets: ExchangeSet[] } | { kind: 'entries'; entries: ExchangeEntry[] }

/** Detect what (if anything) the clipboard text contains. */
export function parseClipboard(text: string): ClipboardContent | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (isObj(v) && Array.isArray(v.sets)) v = v.sets
  const list = Array.isArray(v) ? v : [v]
  if (list.length === 0) return null
  if (list.every(looksLikeSet) && list.every((s) => setProblem(s) === null)) {
    return { kind: 'sets', sets: list as ExchangeSet[] }
  }
  if (list.every(looksLikeEntry) && list.every((e, i) => entryProblem(e, `[${i}]`) === null)) {
    return { kind: 'entries', entries: list as ExchangeEntry[] }
  }
  return null
}

/** Parse the JSON view of one set; keeps id and (where possible) entry ids of `current`. */
export function parseSetJson(
  text: string,
  current: ForwardSet,
  servers: ServersDoc
): { ok: true; set: ForwardSet } | { ok: false; error: string } {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
  }
  const problem = setProblem(v)
  if (problem) return { ok: false, error: problem }
  const x = v as ExchangeSet
  const server = resolveServerRef(x.server, servers)
  if (!server) return { ok: false, error: `Unknown server "${x.server}"` }
  const proxyJump = x.proxyJump?.map((r) => ({ r, id: resolveServerRef(r, servers) }))
  const badJump = proxyJump?.find((p) => !p.id)
  if (badJump) return { ok: false, error: `Unknown jump server "${badJump.r}"` }

  const imported = fromExchangeSet(x, servers)
  // keep entry ids by position so selection/status survive edits
  imported.forwards.forEach((f, i) => {
    if (current.forwards[i]) f.id = current.forwards[i].id
  })
  const set: ForwardSet = { ...imported, id: current.id, server }
  delete set.unresolvedServer
  if (proxyJump) set.proxyJump = proxyJump.map((p) => p.id as string)
  return { ok: true, set }
}
