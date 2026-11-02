import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectChain, type ConnectDeps } from '../src/main/ssh/connect'
import { KnownHosts } from '../src/main/ssh/knownHosts'
import { TunnelManager } from '../src/main/tunnels/tunnelManager'
import { resolveSetHops } from '../src/shared/proxy'
import type { ForwardSet, ServersDoc, SshServer, TunnelSetStatus } from '../src/shared/types'
import { echoRoundTrip, freePort, startEchoServer, startTestServer } from './helpers/sshServer'

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function deps(): ConnectDeps {
  return {
    knownHosts: new KnownHosts(join(mkdtempSync(join(tmpdir(), 'kh-')), 'known_hosts')),
    prompter: { hostKey: async () => true, secret: async () => null, keyboardInteractive: async () => null },
    keepaliveInterval: 30,
    readyTimeout: 5,
    homeDir: mkdtempSync(join(tmpdir(), 'home-')),
    agentPath: null
  }
}

function socksConnect(proxyPort: number, host: string, port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1')
    let stage = 0
    let buf = Buffer.alloc(0)
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])))
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      if (stage === 0 && buf.length >= 2) {
        buf = buf.subarray(2)
        stage = 1
        const h = Buffer.from(host)
        const req = Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 0xff])])
        s.write(req)
      } else if (stage === 1 && buf.length >= 10) {
        if (buf[1] !== 0) return reject(new Error('socks failure ' + buf[1]))
        buf = buf.subarray(10)
        stage = 2
        s.write(payload)
      }
      if (stage === 2 && buf.length >= payload.length) {
        s.destroy()
        resolve(buf.toString())
      }
    })
    s.on('error', reject)
  })
}

const waitFor = async (pred: () => boolean, ms = 8000) => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function setup(extra: { password?: string } = {}) {
  const jump = await startTestServer({ password: 'j' })
  const target = await startTestServer({ password: 't' })
  const echo = await startEchoServer()
  cleanups.push(() => jump.close(), () => target.close(), () => echo.close())
  const servers: ServersDoc = {
    folders: [],
    servers: [
      { id: 'jump', type: 'ssh', name: 'jump', host: '127.0.0.1', port: jump.port, username: 'tester', auth: { method: 'password', password: 'j' } },
      {
        id: 'target',
        type: 'ssh',
        name: 'target',
        host: '127.0.0.1',
        port: target.port,
        username: 'tester',
        auth: { method: 'password', password: extra.password ?? 't' },
        proxyJump: { enabled: true, chain: ['jump'] }
      }
    ]
  }
  const sets = new Map<string, ForwardSet>()
  let connects = 0
  const d = deps()
  const mgr = new TunnelManager({
    getSet: (id) => sets.get(id),
    resolveHops: (set) => resolveSetHops(set, servers),
    connect: (hops: SshServer[]) => {
      connects++
      return connectChain(hops, d)
    },
    backoff: () => ({ min: 0.05, max: 0.2 })
  })
  cleanups.push(() => mgr.stopAll())
  return { jump, target, echo, sets, mgr, connects: () => connects }
}

const st = (mgr: TunnelManager, id: string): TunnelSetStatus => mgr.status(id)

describe('TunnelManager', () => {
  it('runs local, remote and dynamic forwards through a jump host', async () => {
    const { echo, sets, mgr } = await setup()
    const [lp, rp, dp] = [await freePort(), await freePort(), await freePort()]
    sets.set('s', {
      id: 's',
      name: 'S',
      server: 'target',
      forwards: [
        { id: 'l', type: 'local', enabled: true, bindAddress: '127.0.0.1', bindPort: lp, targetHost: '127.0.0.1', targetPort: echo.port },
        { id: 'r', type: 'remote', enabled: true, bindAddress: '127.0.0.1', bindPort: rp, targetHost: '127.0.0.1', targetPort: echo.port },
        { id: 'd', type: 'dynamic', enabled: true, bindAddress: '127.0.0.1', bindPort: dp },
        { id: 'off', type: 'dynamic', enabled: false, bindPort: 1 }
      ]
    })
    await mgr.activate('s')
    expect(st(mgr, 's').state).toBe('active')
    expect(st(mgr, 's').entries.map((e) => [e.id, e.state])).toEqual([
      ['l', 'active'],
      ['r', 'active'],
      ['d', 'active'],
      ['off', 'off']
    ])
    expect(await echoRoundTrip(lp, 'local')).toBe('local')
    expect(await echoRoundTrip(rp, 'remote')).toBe('remote')
    expect(await socksConnect(dp, '127.0.0.1', echo.port, 'socks')).toBe('socks')
  })

  it('keeps other entries running when one port is already taken', async () => {
    const { echo, sets, mgr } = await setup()
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    cleanups.push(() => new Promise((r) => blocker.close(r)))
    const taken = (blocker.address() as net.AddressInfo).port
    const free = await freePort()
    sets.set('s', {
      id: 's',
      name: 'S',
      server: 'target',
      forwards: [
        { id: 'bad', type: 'local', enabled: true, bindAddress: '127.0.0.1', bindPort: taken, targetHost: '127.0.0.1', targetPort: echo.port },
        { id: 'good', type: 'local', enabled: true, bindAddress: '127.0.0.1', bindPort: free, targetHost: '127.0.0.1', targetPort: echo.port }
      ]
    })
    await mgr.activate('s')
    const s = st(mgr, 's')
    expect(s.state).toBe('active')
    expect(s.entries[0]).toMatchObject({ id: 'bad', state: 'error', error: expect.stringMatching(/in use|EADDRINUSE/i) })
    expect(s.entries[1].state).toBe('active')
    expect(await echoRoundTrip(free)).toBe('ping')
  })

  it('does not retry when the initial connection fails', async () => {
    const { sets, mgr, connects } = await setup({ password: 'wrong' })
    sets.set('s', { id: 's', name: 'S', server: 'target', forwards: [] })
    await mgr.activate('s')
    expect(st(mgr, 's')).toMatchObject({ state: 'error', error: expect.stringMatching(/Authentication (failed|cancelled)/) })
    await new Promise((r) => setTimeout(r, 400))
    expect(connects()).toBe(1)
  })

  it('reconnects with backoff after an established connection drops', async () => {
    const { echo, target, sets, mgr } = await setup()
    const lp = await freePort()
    sets.set('s', {
      id: 's',
      name: 'S',
      server: 'target',
      proxyJump: [],
      forwards: [{ id: 'l', type: 'local', enabled: true, bindAddress: '127.0.0.1', bindPort: lp, targetHost: '127.0.0.1', targetPort: echo.port }]
    })
    const states: string[] = []
    mgr.on('change', (s: TunnelSetStatus) => states.push(s.state))
    await mgr.activate('s')
    target.dropAll()
    await waitFor(() => states.includes('reconnecting'))
    await waitFor(() => st(mgr, 's').state === 'active' && states.lastIndexOf('active') > states.indexOf('reconnecting'))
    expect(await echoRoundTrip(lp, 'again')).toBe('again')
  })

  it('stops listeners on deactivate and cancels pending reconnects', async () => {
    const { echo, target, sets, mgr, connects } = await setup()
    const lp = await freePort()
    sets.set('s', {
      id: 's',
      name: 'S',
      server: 'target',
      proxyJump: [],
      forwards: [{ id: 'l', type: 'local', enabled: true, bindAddress: '127.0.0.1', bindPort: lp, targetHost: '127.0.0.1', targetPort: echo.port }]
    })
    await mgr.activate('s')
    await mgr.deactivate('s')
    expect(st(mgr, 's').state).toBe('off')
    await expect(echoRoundTrip(lp)).rejects.toThrow(/ECONNREFUSED/)

    await mgr.activate('s')
    target.dropAll()
    await waitFor(() => st(mgr, 's').state === 'reconnecting')
    const before = connects()
    await mgr.deactivate('s')
    await new Promise((r) => setTimeout(r, 400))
    expect(connects()).toBe(before)
    expect(st(mgr, 's').state).toBe('off')
  })

  it('reports configuration problems (unresolved server) as error', async () => {
    const { sets, mgr } = await setup()
    sets.set('s', { id: 's', name: 'S', server: '', unresolvedServer: 'gone', forwards: [] })
    await mgr.activate('s')
    expect(st(mgr, 's')).toMatchObject({ state: 'error', error: expect.stringMatching(/gone/) })
  })
})
