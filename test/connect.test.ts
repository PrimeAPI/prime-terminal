import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectChain, type ConnectDeps, type Prompter } from '../src/main/ssh/connect'
import { KnownHosts } from '../src/main/ssh/knownHosts'
import type { SshServer } from '../src/shared/types'
import { genKey, startTestServer, type TestServer } from './helpers/sshServer'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function server(opts: Parameters<typeof startTestServer>[0]) {
  const s = await startTestServer(opts)
  servers.push(s)
  return s
}

function hop(id: string, port: number, auth: SshServer['auth'], host = '127.0.0.1'): SshServer {
  return { id, type: 'ssh', name: id, host, port, username: 'tester', auth }
}

interface Calls {
  hostKey: string[]
  secret: string[]
  kbd: number
}

function makeDeps(over: Partial<Prompter> & { home?: string } = {}): { deps: ConnectDeps; calls: Calls; saved: unknown[] } {
  const home = over.home ?? mkdtempSync(join(tmpdir(), 'home-'))
  const calls: Calls = { hostKey: [], secret: [], kbd: 0 }
  const saved: unknown[] = []
  const prompter: Prompter = {
    hostKey: async (r) => {
      calls.hostKey.push(`${r.status}:${r.port}`)
      return over.hostKey ? over.hostKey(r) : true
    },
    secret: async (r) => {
      calls.secret.push(r.secret)
      return over.secret ? over.secret(r) : null
    },
    keyboardInteractive: async (r) => {
      calls.kbd++
      return over.keyboardInteractive ? over.keyboardInteractive(r) : null
    }
  }
  return {
    calls,
    saved,
    deps: {
      knownHosts: new KnownHosts(join(home, '.ssh', 'known_hosts')),
      prompter,
      keepaliveInterval: 30,
      readyTimeout: 10,
      homeDir: home,
      agentPath: null,
      onSecretSaved: (id, field, value) => saved.push({ id, field, value })
    }
  }
}

function shellEcho(conn: Awaited<ReturnType<typeof connectChain>>, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, ch) => {
      if (err) return reject(err)
      let buf = ''
      ch.on('data', (d: Buffer) => {
        buf += d.toString()
        if (buf.includes(text)) {
          ch.end()
          resolve(buf)
        }
      })
      ch.write(text)
    })
  })
}

describe('connectChain', () => {
  it('connects directly with a stored password and opens a shell', async () => {
    const s = await server({ password: 'pw' })
    const { deps } = makeDeps()
    const conn = await connectChain([hop('t', s.port, { method: 'password', password: 'pw' })], deps)
    expect(await shellEcho(conn, 'hello')).toContain('welcome')
    conn.close()
  })

  it('asks to trust unknown host keys once and remembers them in known_hosts', async () => {
    const s = await server({ password: 'pw' })
    const { deps, calls } = makeDeps()
    const target = hop('t', s.port, { method: 'password', password: 'pw' })
    ;(await connectChain([target], deps)).close()
    ;(await connectChain([target], deps)).close()
    expect(calls.hostKey).toEqual([`unknown:${s.port}`])
  })

  it('refuses untrusted hosts and blocks changed host keys', async () => {
    const s = await server({ password: 'pw' })
    const target = hop('t', s.port, { method: 'password', password: 'pw' })
    const untrusting = makeDeps({ hostKey: async () => false })
    await expect(connectChain([target], untrusting.deps)).rejects.toThrow(/not trusted/i)

    const home = mkdtempSync(join(tmpdir(), 'home-'))
    const other = genKey()
    const [type, b64] = other.public.split(' ')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'known_hosts'), `[127.0.0.1]:${s.port} ${type} ${b64}\n`)
    const changed = makeDeps({ home })
    await expect(connectChain([target], changed.deps)).rejects.toThrow(/changed/i)
    expect(changed.calls.hostKey).toEqual([`changed:${s.port}`])
  })

  it('authenticates with an explicit encrypted key, prompting for the passphrase and saving it on request', async () => {
    const key = genKey('ed25519', 'secret')
    const s = await server({ authorizedKey: key.public })
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    writeFileSync(join(home, 'mykey'), key.private)
    const { deps, calls, saved } = makeDeps({ home, secret: async () => ({ value: 'secret', save: true }) })
    const conn = await connectChain([hop('t', s.port, { method: 'key', keyPath: '~/mykey' })], deps)
    conn.close()
    expect(calls.secret).toEqual(['passphrase'])
    expect(saved).toEqual([{ id: 't', field: 'keyPassphrase', value: 'secret' }])
  })

  it('auto mode picks up default keys from ~/.ssh', async () => {
    const key = genKey()
    const s = await server({ authorizedKey: key.public })
    const home = mkdtempSync(join(tmpdir(), 'home-'))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id_ed25519'), key.private)
    const { deps, calls } = makeDeps({ home })
    const conn = await connectChain([hop('t', s.port, { method: 'auto' })], deps)
    conn.close()
    expect(calls.secret).toEqual([])
  })

  it('prompts for a password when none is stored and retries on a wrong answer', async () => {
    const s = await server({ password: 'right' })
    const answers = ['wrong', 'right']
    const { deps, calls, saved } = makeDeps({ secret: async () => ({ value: answers.shift()!, save: false }) })
    const conn = await connectChain([hop('t', s.port, { method: 'password' })], deps)
    conn.close()
    expect(calls.secret).toEqual(['password', 'password'])
    expect(saved).toEqual([])
  })

  it('supports keyboard-interactive (2FA) prompts', async () => {
    const s = await server({ kbd: { prompt: 'Code: ', answer: '123456' } })
    const { deps, calls } = makeDeps({ keyboardInteractive: async () => ['123456'] })
    const conn = await connectChain([hop('t', s.port, { method: 'auto' })], deps)
    conn.close()
    expect(calls.kbd).toBe(1)
  })

  it('reports cancelled authentication clearly', async () => {
    const s = await server({ password: 'pw' })
    const { deps } = makeDeps({ secret: async () => null })
    await expect(connectChain([hop('t', s.port, { method: 'password' })], deps)).rejects.toThrow(/cancel/i)
  })

  it('connects through a chain of two jump hosts and checks every hop key', async () => {
    const j1 = await server({ password: 'a' })
    const j2 = await server({ password: 'b' })
    const t = await server({ password: 'c' })
    const { deps, calls } = makeDeps()
    const conn = await connectChain(
      [
        hop('j1', j1.port, { method: 'password', password: 'a' }),
        hop('j2', j2.port, { method: 'password', password: 'b' }),
        hop('t', t.port, { method: 'password', password: 'c' })
      ],
      deps
    )
    expect(await shellEcho(conn, 'via-jumps')).toContain('via-jumps')
    expect(calls.hostKey).toEqual([`unknown:${j1.port}`, `unknown:${j2.port}`, `unknown:${t.port}`])
    expect(j1.connections.size).toBe(1)
    conn.close()
  })

  it('emits close once when an intermediate hop drops', async () => {
    const j1 = await server({ password: 'a' })
    const t = await server({ password: 'c' })
    const { deps } = makeDeps()
    const conn = await connectChain(
      [hop('j1', j1.port, { method: 'password', password: 'a' }), hop('t', t.port, { method: 'password', password: 'c' })],
      deps
    )
    let closes = 0
    const closed = new Promise<void>((r) =>
      conn.on('close', () => {
        closes++
        r()
      })
    )
    j1.dropAll()
    await closed
    await new Promise((r) => setTimeout(r, 100))
    expect(closes).toBe(1)
  })

  it('fails with a readable error when a host is unreachable', async () => {
    const { deps } = makeDeps()
    await expect(connectChain([hop('t', 1, { method: 'password', password: 'x' })], deps)).rejects.toThrow(/ECONNREFUSED|refused/i)
  })
})
