import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { SessionManager, type SessionBackend } from '../src/main/sessions/sessionManager'
import { RingBuffer } from '../src/main/sessions/ringBuffer'

class FakeBackend extends EventEmitter implements SessionBackend {
  written: string[] = []
  size: [number, number] = [0, 0]
  closed = false
  constructor(private readonly fail?: string) {
    super()
  }
  async start(cols: number, rows: number) {
    this.size = [cols, rows]
    if (this.fail) throw new Error(this.fail)
  }
  write(d: string) {
    this.written.push(d)
  }
  resize(c: number, r: number) {
    this.size = [c, r]
  }
  close() {
    this.closed = true
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function setup(fail?: string) {
  const backends: FakeBackend[] = []
  const mgr = new SessionManager()
  const out: string[] = []
  const states: string[] = []
  mgr.on('data', (_id: string, d: string) => out.push(d))
  mgr.on('state', (_id: string, s: string) => states.push(s))
  const id = mgr.create({
    title: 'web',
    kind: 'ssh',
    serverId: 'web',
    factory: () => {
      const b = new FakeBackend(backends.length === 0 ? fail : undefined)
      backends.push(b)
      return b
    }
  })
  return { mgr, id, backends, out, states }
}

describe('SessionManager', () => {
  it('starts the backend with the last known size and forwards IO', async () => {
    const { mgr, id, backends, out, states } = setup()
    mgr.resize(id, 120, 40)
    mgr.start(id)
    await tick()
    expect(backends[0].size).toEqual([120, 40])
    expect(states).toEqual(['connecting', 'connected'])
    backends[0].emit('data', 'hello')
    expect(out.join('')).toContain('hello')
    mgr.write(id, 'ls\r')
    expect(backends[0].written).toEqual(['ls\r'])
  })

  it('shows a reconnect hint when the connection closes and reconnects on Enter only', async () => {
    const { mgr, id, backends, out, states } = setup()
    mgr.start(id)
    await tick()
    backends[0].emit('exit', 'Connection closed')
    expect(states.at(-1)).toBe('closed')
    expect(out.join('')).toMatch(/press Enter to reconnect/)
    mgr.write(id, 'x')
    expect(backends.length).toBe(1)
    mgr.write(id, '\r')
    await tick()
    expect(backends.length).toBe(2)
    expect(states.at(-1)).toBe('connected')
  })

  it('reports start failures in the terminal and allows retrying', async () => {
    const { mgr, id, backends, out, states } = setup('Authentication failed')
    mgr.start(id)
    await tick()
    expect(out.join('')).toMatch(/Authentication failed/)
    expect(states.at(-1)).toBe('closed')
    mgr.write(id, '\r')
    await tick()
    expect(backends.length).toBe(2)
    expect(states.at(-1)).toBe('connected')
  })

  it('keeps output in a snapshot for re-attaching (tab moved to another window)', async () => {
    const { mgr, id, backends } = setup()
    mgr.start(id)
    await tick()
    backends[0].emit('data', 'line1\r\n')
    backends[0].emit('data', 'line2\r\n')
    expect(mgr.snapshot(id)).toContain('line1\r\nline2\r\n')
  })

  it('closing kills the backend and forgets the session', async () => {
    const { mgr, id, backends } = setup()
    mgr.start(id)
    await tick()
    mgr.close(id)
    expect(backends[0].closed).toBe(true)
    expect(mgr.has(id)).toBe(false)
  })

  it('a close during connect still shuts the backend down', async () => {
    const mgr = new SessionManager()
    let resolveStart!: () => void
    const b = new FakeBackend()
    b.start = () => new Promise<void>((r) => (resolveStart = r))
    const id = mgr.create({ title: 't', kind: 'ssh', serverId: null, factory: () => b })
    mgr.start(id)
    mgr.close(id)
    resolveStart()
    await tick()
    expect(b.closed).toBe(true)
  })
})

describe('RingBuffer', () => {
  it('drops the oldest chunks beyond the limit', () => {
    const r = new RingBuffer(10)
    r.push('12345')
    r.push('67890')
    r.push('abc')
    expect(r.toString()).toBe('67890abc')
  })
  it('truncates a single oversized chunk to its tail', () => {
    const r = new RingBuffer(4)
    r.push('abcdefgh')
    expect(r.toString()).toBe('efgh')
  })
})
