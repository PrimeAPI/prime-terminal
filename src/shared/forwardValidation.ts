import type { ForwardEntry, ForwardSet, ServersDoc } from './types'
import { validateServerJumpChain } from './proxy'

export interface Issue {
  entryId?: string
  field?: string
  message: string
}

export interface ValidationResult {
  errors: Issue[]
  warnings: Issue[]
}

const validPort = (p: unknown): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535

/** Address the forward listens on, on the local machine (null for remote forwards). */
function localBindKey(e: ForwardEntry): string | null {
  if (e.type === 'remote' || !e.enabled) return null
  return String(e.bindPort)
}

export function validateForwardSet(
  set: ForwardSet,
  ctx: { servers: ServersDoc; activeSets?: ForwardSet[] }
): ValidationResult {
  const errors: Issue[] = []
  const warnings: Issue[] = []

  if (!set.name || !set.name.trim()) errors.push({ field: 'name', message: 'Name is required' })

  const target = ctx.servers.servers.find((s) => s.id === set.server)
  if (!set.server) {
    errors.push({
      field: 'server',
      message: set.unresolvedServer ? `Server "${set.unresolvedServer}" not found – choose a server` : 'Target server is required'
    })
  } else if (!target) errors.push({ field: 'server', message: 'Target server no longer exists' })
  else if (target.type !== 'ssh') errors.push({ field: 'server', message: 'Target must be an SSH server' })

  if (set.proxyJump && set.server) {
    for (const p of validateServerJumpChain(set.server, set.proxyJump, ctx.servers)) {
      errors.push({ field: 'proxyJump', message: p })
    }
  }

  const seenLocal = new Map<string, string>()
  const seenRemote = new Map<string, string>()
  for (const e of set.forwards) {
    if (!['local', 'remote', 'dynamic'].includes(e.type)) {
      errors.push({ entryId: e.id, field: 'type', message: 'Type must be local, remote or dynamic' })
      continue
    }
    if (!validPort(e.bindPort)) errors.push({ entryId: e.id, field: 'bindPort', message: 'Bind port must be 1–65535' })
    if (e.type !== 'dynamic') {
      if (!e.targetHost || !e.targetHost.trim())
        errors.push({ entryId: e.id, field: 'targetHost', message: 'Target host is required' })
      if (!validPort(e.targetPort))
        errors.push({ entryId: e.id, field: 'targetPort', message: 'Target port must be 1–65535' })
    }
    if (!e.enabled || !validPort(e.bindPort)) continue

    const map = e.type === 'remote' ? seenRemote : seenLocal
    const key = String(e.bindPort)
    if (map.has(key)) {
      errors.push({ entryId: e.id, field: 'bindPort', message: `Bind port ${key} is already used in this set` })
    } else map.set(key, e.id)

    if (e.type !== 'remote' && e.bindPort < 1024) {
      warnings.push({
        entryId: e.id,
        field: 'bindPort',
        message: `Port ${e.bindPort} is below 1024 and may need administrator/root privileges`
      })
    }
  }

  for (const other of ctx.activeSets ?? []) {
    if (other.id === set.id) continue
    const otherPorts = new Set(other.forwards.map(localBindKey).filter((x): x is string => x !== null))
    for (const e of set.forwards) {
      const k = localBindKey(e)
      if (k && otherPorts.has(k)) {
        warnings.push({
          entryId: e.id,
          field: 'bindPort',
          message: `Port ${k} is also used by active set "${other.name}"`
        })
      }
    }
  }

  return { errors, warnings }
}
