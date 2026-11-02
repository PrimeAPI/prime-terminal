// In-process SSH server for integration tests (password, publickey, keyboard-interactive,
// shell echo, direct-tcpip and tcpip-forward).
import net from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { Server, utils, type Connection } from 'ssh2'

export interface TestServerOptions {
  username?: string
  password?: string
  /** Public key (OpenSSH format line) accepted for publickey auth. */
  authorizedKey?: string
  /** Keyboard-interactive: question -> expected answer. */
  kbd?: { prompt: string; answer: string }
  hostKey?: string
}

export interface TestServer {
  port: number
  hostKeyBlob: Buffer
  connections: Set<Connection>
  /** Kill all client connections (simulates network drop). */
  dropAll(): void
  close(): Promise<void>
  authLog: string[]
}

export function genKey(type: 'ed25519' | 'rsa' = 'ed25519', passphrase?: string) {
  // ssh2's generator occasionally emits keys its own parser rejects ("Malformed OpenSSH private key");
  // retry so tests are deterministic.
  for (let i = 0; i < 20; i++) {
    const opts = (passphrase ? { passphrase, cipher: 'aes256-cbc', rounds: 16 } : {}) as { passphrase: string; cipher: string; rounds: number }
    const kp = type === 'rsa' ? utils.generateKeyPairSync('rsa', { bits: 2048, ...opts }) : utils.generateKeyPairSync('ed25519', opts)
    if (!(utils.parseKey(kp.private, passphrase) instanceof Error) && !(utils.parseKey(kp.public) instanceof Error)) return kp
  }
  throw new Error('could not generate a parseable key')
}

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const hostKey = opts.hostKey ?? genKey().private
  const parsedHost = utils.parseKey(hostKey)
  if (parsedHost instanceof Error) throw parsedHost
  const hostKeyBlob = parsedHost.getPublicSSH()
  const allowedPub = opts.authorizedKey ? utils.parseKey(opts.authorizedKey) : null
  const username = opts.username ?? 'tester'
  const connections = new Set<Connection>()
  const sockets = new Set<net.Socket>()
  const authLog: string[] = []

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    connections.add(client)
    client.on('close', () => connections.delete(client))
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      authLog.push(ctx.method)
      if (ctx.username !== username) return ctx.reject()
      if (ctx.method === 'password' && opts.password && eq(ctx.password, opts.password)) return ctx.accept()
      if (ctx.method === 'publickey' && allowedPub && !(allowedPub instanceof Error)) {
        const same =
          ctx.key.algo === allowedPub.type && ctx.key.data.equals(allowedPub.getPublicSSH())
        if (!same) return ctx.reject()
        if (!ctx.signature) return ctx.accept()
        if (ctx.blob && allowedPub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept()
        return ctx.reject()
      }
      if (ctx.method === 'keyboard-interactive' && opts.kbd) {
        const kbd = opts.kbd
        return ctx.prompt([{ prompt: kbd.prompt, echo: false }], 'Two factor', 'Enter code', (answers) => {
          if (answers[0] === kbd.answer) ctx.accept()
          else ctx.reject()
        })
      }
      const methods: ('password' | 'publickey' | 'keyboard-interactive')[] = []
      if (opts.password) methods.push('password')
      if (allowedPub) methods.push('publickey')
      if (opts.kbd) methods.push('keyboard-interactive')
      ctx.reject(methods)
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (a) => a?.())
        session.on('window-change', (a) => a?.())
        session.on('shell', (a) => {
          const ch = a()
          ch.write('welcome\r\n')
          ch.on('data', (d: Buffer) => {
            if (d.toString() === '\x04') {
              ch.exit(0)
              ch.end()
              return
            }
            ch.write(d)
          })
        })
      })
      client.on('tcpip', (accept, reject, info) => {
        const sock = net.connect(info.destPort, info.destIP)
        sock.once('connect', () => {
          const ch = accept()
          sock.pipe(ch).pipe(sock)
          sockets.add(sock)
        })
        sock.once('error', () => reject?.())
      })
      client.on('request', (accept, reject, name, info: any) => {
        if (name !== 'tcpip-forward') return reject?.()
        const srv = net.createServer((sock) => {
          client.forwardOut(info.bindAddr, info.bindPort, sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, (err, ch) => {
            if (err) return sock.destroy()
            sock.pipe(ch).pipe(sock)
          })
        })
        srv.once('error', () => reject?.())
        srv.listen(info.bindPort, info.bindAddr || '127.0.0.1', () => accept?.())
        client.once('close', () => srv.close())
      })
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    hostKeyBlob,
    connections,
    authLog,
    dropAll() {
      for (const c of connections) c.end()
      for (const s of sockets) s.destroy()
    },
    close() {
      for (const c of connections) c.end()
      return new Promise((r) => server.close(() => r()))
    }
  }
}

/** Simple TCP echo server used as forward target. */
export async function startEchoServer(): Promise<{ port: number; close(): Promise<void> }> {
  const socks = new Set<net.Socket>()
  const srv = net.createServer((s) => {
    socks.add(s)
    s.on('close', () => socks.delete(s))
    s.pipe(s)
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return {
    port: (srv.address() as net.AddressInfo).port,
    close: () => {
      for (const s of socks) s.destroy()
      return new Promise((r) => srv.close(() => r()))
    }
  }
}

export function echoRoundTrip(port: number, payload = 'ping'): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    let buf = ''
    s.on('data', (d) => {
      buf += d.toString()
      if (buf.length >= payload.length) {
        s.destroy()
        resolve(buf)
      }
    })
    s.on('error', reject)
    s.setTimeout(5000, () => {
      s.destroy()
      reject(new Error('timeout'))
    })
    s.on('connect', () => s.write(payload))
  })
}

export async function freePort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as net.AddressInfo).port
  await new Promise((r) => srv.close(r))
  return port
}
