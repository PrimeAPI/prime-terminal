import { describe, expect, it } from 'vitest'
import { validateForwardSet } from '../src/shared/forwardValidation'
import {
  fromExchangeEntry,
  fromExchangeSet,
  parseClipboard,
  parseSetJson,
  toExchangeEntry,
  toExchangeSet
} from '../src/shared/setExchange'
import type { ForwardSet, ServersDoc } from '../src/shared/types'

const servers: ServersDoc = {
  folders: [],
  servers: [
    { id: 'id-web', type: 'ssh', name: 'web-01', host: 'w', port: 22, username: 'u', auth: { method: 'auto' } },
    { id: 'id-bastion', type: 'ssh', name: 'bastion', host: 'b', port: 22, username: 'u', auth: { method: 'auto' } }
  ]
}

const set = (over: Partial<ForwardSet> = {}): ForwardSet => ({
  id: 'set1',
  name: 'App X',
  server: 'id-web',
  forwards: [
    { id: 'e1', name: 'db', type: 'local', enabled: true, bindAddress: '127.0.0.1', bindPort: 5432, targetHost: 'db.internal', targetPort: 5432 },
    { id: 'e2', name: 'socks', type: 'dynamic', enabled: true, bindPort: 1080 }
  ],
  ...over
})

describe('validateForwardSet', () => {
  it('accepts a valid set', () => {
    const r = validateForwardSet(set(), { servers })
    expect(r.errors).toEqual([])
  })

  it('flags out-of-range ports and missing targets per entry and field', () => {
    const s = set({
      forwards: [
        { id: 'a', type: 'local', enabled: true, bindPort: 70000, targetHost: '', targetPort: 0 },
        { id: 'b', type: 'remote', enabled: true, bindPort: 8080, targetHost: 'x' }
      ]
    })
    const errs = validateForwardSet(s, { servers }).errors
    expect(errs).toContainEqual(expect.objectContaining({ entryId: 'a', field: 'bindPort' }))
    expect(errs).toContainEqual(expect.objectContaining({ entryId: 'a', field: 'targetHost' }))
    expect(errs).toContainEqual(expect.objectContaining({ entryId: 'a', field: 'targetPort' }))
    expect(errs).toContainEqual(expect.objectContaining({ entryId: 'b', field: 'targetPort' }))
  })

  it('does not require targets for dynamic forwards', () => {
    const s = set({ forwards: [{ id: 'd', type: 'dynamic', enabled: true, bindPort: 1080 }] })
    expect(validateForwardSet(s, { servers }).errors).toEqual([])
  })

  it('reports duplicate local bind ports among enabled entries only', () => {
    const dup = set({
      forwards: [
        { id: 'a', type: 'local', enabled: true, bindPort: 9000, targetHost: 'h', targetPort: 1 },
        { id: 'b', type: 'dynamic', enabled: true, bindPort: 9000 },
        { id: 'c', type: 'local', enabled: false, bindPort: 9000, targetHost: 'h', targetPort: 1 },
        { id: 'd', type: 'remote', enabled: true, bindPort: 9000, targetHost: 'h', targetPort: 1 }
      ]
    })
    const errs = validateForwardSet(dup, { servers }).errors.filter((e) => e.field === 'bindPort')
    expect(errs.map((e) => e.entryId).sort()).toEqual(['b'])
  })

  it('warns about privileged ports and conflicts with other active sets', () => {
    const s = set({ forwards: [{ id: 'a', type: 'local', enabled: true, bindPort: 80, targetHost: 'h', targetPort: 80 }] })
    const other = set({ id: 'other', name: 'Other', forwards: [{ id: 'o', type: 'dynamic', enabled: true, bindPort: 80 }] })
    const r = validateForwardSet(s, { servers, activeSets: [other] })
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/1024/)
    expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/Other/)
  })

  it('requires a name and a resolvable SSH server', () => {
    const r = validateForwardSet(set({ name: ' ', server: '', unresolvedServer: 'gone' }), { servers })
    expect(r.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['name', 'server']))
  })
})

describe('set exchange format', () => {
  it('exports server references by name and drops ids', () => {
    const x = toExchangeSet(set({ proxyJump: ['id-bastion'], autoStart: true }), servers)
    expect(x).toEqual({
      name: 'App X',
      server: 'web-01',
      proxyJump: ['bastion'],
      autoStart: true,
      forwards: [
        { name: 'db', type: 'local', enabled: true, bindAddress: '127.0.0.1', bindPort: 5432, targetHost: 'db.internal', targetPort: 5432 },
        { name: 'socks', type: 'dynamic', enabled: true, bindPort: 1080 }
      ]
    })
  })

  it('keeps auto-start and auto-reconnect flags in the exchange format', () => {
    const x = toExchangeSet(set({ autoStart: true, autoReconnect: false }), servers)
    expect(x).toMatchObject({ autoStart: true, autoReconnect: false })
    expect(fromExchangeSet(x, servers)).toMatchObject({ autoStart: true, autoReconnect: false })
    expect(toExchangeSet(set(), servers)).not.toHaveProperty('autoReconnect')
  })

  it('round-trips through import with fresh ids', () => {
    const imported = fromExchangeSet(toExchangeSet(set({ proxyJump: ['id-bastion'] }), servers), servers)
    expect(imported.id).not.toBe('set1')
    expect(imported.server).toBe('id-web')
    expect(imported.proxyJump).toEqual(['id-bastion'])
    expect(imported.forwards.map((f) => f.id)).not.toContain('e1')
    expect(imported.forwards[0].targetHost).toBe('db.internal')
  })

  it('resolves by id first, then by name, and marks unknown servers as unresolved', () => {
    expect(fromExchangeSet({ name: 'a', server: 'id-web', forwards: [] }, servers).server).toBe('id-web')
    const u = fromExchangeSet({ name: 'a', server: 'web-99', forwards: [] }, servers)
    expect(u.server).toBe('')
    expect(u.unresolvedServer).toBe('web-99')
  })

  it('fills entry defaults on import', () => {
    const e = fromExchangeEntry({ type: 'dynamic', bindPort: 1080 })
    expect(e).toMatchObject({ type: 'dynamic', bindPort: 1080, enabled: true, bindAddress: '127.0.0.1' })
    expect(e.id).toBeTruthy()
    expect(toExchangeEntry(e)).not.toHaveProperty('id')
  })
})

describe('parseClipboard', () => {
  it('detects a single set, a list of sets and a sets document', () => {
    const x = toExchangeSet(set(), servers)
    expect(parseClipboard(JSON.stringify(x))).toMatchObject({ kind: 'sets', sets: [x] })
    expect(parseClipboard(JSON.stringify([x, x]))).toMatchObject({ kind: 'sets' })
    expect(parseClipboard(JSON.stringify({ sets: [x] }))).toMatchObject({ kind: 'sets' })
  })

  it('detects single entries and lists of entries', () => {
    expect(parseClipboard('{"type":"local","bindPort":1,"targetHost":"h","targetPort":2}')).toMatchObject({ kind: 'entries' })
    expect(parseClipboard('[{"type":"dynamic","bindPort":1080}]')).toMatchObject({ kind: 'entries' })
  })

  it('returns null for unrelated text', () => {
    expect(parseClipboard('hello')).toBeNull()
    expect(parseClipboard('{"foo":1}')).toBeNull()
    expect(parseClipboard('[]')).toBeNull()
  })
})

describe('parseSetJson (JSON view)', () => {
  it('applies edited JSON onto the existing set, keeping its id', () => {
    const text = JSON.stringify({ ...toExchangeSet(set(), servers), name: 'Renamed' })
    const r = parseSetJson(text, set(), servers)
    expect(r.ok && r.set.id).toBe('set1')
    expect(r.ok && r.set.name).toBe('Renamed')
  })

  it('rejects invalid JSON and unknown servers with a message', () => {
    expect(parseSetJson('{', set(), servers)).toMatchObject({ ok: false })
    const r = parseSetJson(JSON.stringify({ name: 'x', server: 'nope', forwards: [] }), set(), servers)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/nope/) })
  })

  it('rejects structurally invalid entries', () => {
    const r = parseSetJson(JSON.stringify({ name: 'x', server: 'web-01', forwards: [{ type: 'weird', bindPort: 1 }] }), set(), servers)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/type/) })
  })
})
