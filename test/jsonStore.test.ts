import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonFileStore } from '../src/main/config/jsonStore'
import { createConfigStores } from '../src/main/config/configStores'

interface Doc {
  items: number[]
}

const validate = (v: unknown) =>
  typeof v === 'object' && v !== null && Array.isArray((v as Doc).items) ? null : 'items must be a list'

const stores: JsonFileStore<unknown>[] = []
afterEach(() => stores.splice(0).forEach((s) => s.close()))

function make(file: string) {
  const s = new JsonFileStore<Doc>(file, { defaults: () => ({ items: [] }), validate })
  stores.push(s as JsonFileStore<unknown>)
  return s
}

const dir = () => mkdtempSync(join(tmpdir(), 'cfg-'))
const until = async (pred: () => boolean) => {
  const t = Date.now()
  while (!pred()) {
    if (Date.now() - t > 5000) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('JsonFileStore', () => {
  it('creates the file with defaults when missing', () => {
    const f = join(dir(), 'sub', 'a.json')
    const s = make(f)
    s.load()
    expect(s.value).toEqual({ items: [] })
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ items: [] })
  })

  it('keeps the last valid state and reports an error for invalid files', () => {
    const f = join(dir(), 'a.json')
    writeFileSync(f, '{"items":[1]}')
    const s = make(f)
    s.load()
    writeFileSync(f, '{"items": oops')
    s.load()
    expect(s.value).toEqual({ items: [1] })
    expect(s.error).toMatch(/JSON/)
    writeFileSync(f, '{"items": 5}')
    s.load()
    expect(s.error).toMatch(/items must be a list/)
  })

  it('saves pretty-printed JSON atomically and rejects invalid documents', () => {
    const f = join(dir(), 'a.json')
    const s = make(f)
    s.load()
    s.save({ items: [1, 2] })
    expect(readFileSync(f, 'utf8')).toBe('{\n  "items": [\n    1,\n    2\n  ]\n}\n')
    expect(() => s.save({ items: 'x' } as unknown as Doc)).toThrow(/items/)
    expect(existsSync(f + '.tmp')).toBe(false)
  })

  it('saveText validates raw text before writing', () => {
    const s = make(join(dir(), 'a.json'))
    s.load()
    expect(s.saveText('{')).toMatchObject({ ok: false })
    expect(s.saveText('{"items":[3]}')).toEqual({ ok: true })
    expect(s.value).toEqual({ items: [3] })
  })

  it('reloads on external changes and emits change events (not for its own writes)', async () => {
    const f = join(dir(), 'a.json')
    const s = make(f)
    s.load()
    s.watch()
    let changes = 0
    s.on('change', () => changes++)
    s.save({ items: [1] })
    expect(changes).toBe(1)
    await new Promise((r) => setTimeout(r, 300))
    expect(changes).toBe(1)
    writeFileSync(f, '{"items":[42]}')
    await until(() => s.value.items[0] === 42)
    expect(changes).toBe(2)
  })
})

describe('config stores', () => {
  it('fills partial settings with defaults and validates against schemas', () => {
    const d = dir()
    writeFileSync(join(d, 'settings.json'), '{"terminal":{"fontSize":20}}')
    const c = createConfigStores(d)
    c.loadAll()
    expect(c.settings.value.terminal.fontSize).toBe(20)
    expect(c.settings.value.terminal.scrollback).toBe(10000)
    expect(c.settings.value.keybindings.copy).toBe('Ctrl+Shift+C')
    expect(c.servers.saveText('{"folders":[],"servers":[{"id":"x","type":"ssh"}]}')).toMatchObject({ ok: false })
    c.closeAll()
  })

  it('rejects servers documents with invalid jump chains', () => {
    const c = createConfigStores(dir())
    c.loadAll()
    const r = c.servers.saveText(
      JSON.stringify({
        folders: [],
        servers: [{ id: 'a', type: 'ssh', name: 'a', host: 'h', port: 22, username: 'u', auth: { method: 'auto' }, proxyJump: { enabled: true, chain: ['a'] } }]
      })
    )
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/itself/) })
    c.closeAll()
  })
})
