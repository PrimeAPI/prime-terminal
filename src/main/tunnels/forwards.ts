// Starts individual forward entries on an established connection.

import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type { ForwardEntry } from '../../shared/types'
import type { SshConnection } from '../ssh/connect'
import { createSocks5Server } from './socks5'

export interface RunningForward {
  close(): Promise<void>
}

function pipeBoth(a: net.Socket, b: Duplex) {
  a.on('error', () => b.destroy())
  b.on('error', () => a.destroy())
  a.on('close', () => b.destroy())
  b.on('close', () => a.destroy())
  a.pipe(b).pipe(a)
}

function forwardOut(conn: SshConnection, src: net.Socket, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    conn.client.forwardOut(src.remoteAddress ?? '127.0.0.1', src.remotePort ?? 0, host, port, (err, ch) =>
      err ? reject(err) : resolve(ch)
    )
  })
}

function friendlyListenError(e: NodeJS.ErrnoException, addr: string, port: number): Error {
  if (e.code === 'EADDRINUSE') return new Error(`Port ${port} on ${addr} is already in use`)
  if (e.code === 'EACCES') return new Error(`Permission denied to listen on ${addr}:${port}`)
  if (e.code === 'EADDRNOTAVAIL') return new Error(`Address ${addr} is not available`)
  return new Error(e.message)
}

function listen(server: net.Server, addr: string, port: number): Promise<RunningForward> {
  const sockets = new Set<net.Socket>()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(friendlyListenError(e as NodeJS.ErrnoException, addr, port)))
    server.listen(port, addr, () =>
      resolve({
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          })
      })
    )
  })
}

function startLocal(conn: SshConnection, e: ForwardEntry): Promise<RunningForward> {
  const addr = e.bindAddress || '127.0.0.1'
  const server = net.createServer((sock) => {
    sock.pause()
    forwardOut(conn, sock, e.targetHost!, e.targetPort!)
      .then((ch) => {
        pipeBoth(sock, ch)
        sock.resume()
      })
      .catch(() => sock.destroy())
  })
  return listen(server, addr, e.bindPort)
}

function startDynamic(conn: SshConnection, e: ForwardEntry): Promise<RunningForward> {
  const addr = e.bindAddress || '127.0.0.1'
  const server = createSocks5Server((host, port, src) => forwardOut(conn, src, host, port))
  return listen(server, addr, e.bindPort)
}

/** Remote forwards share one 'tcp connection' dispatcher per connection. */
const dispatchers = new WeakMap<SshConnection, Map<number, ForwardEntry>>()

function startRemote(conn: SshConnection, e: ForwardEntry): Promise<RunningForward> {
  let routes = dispatchers.get(conn)
  if (!routes) {
    const r = new Map<number, ForwardEntry>()
    routes = r
    dispatchers.set(conn, r)
    conn.client.on('tcp connection', (info, accept, reject) => {
      const entry = r.get(info.destPort)
      if (!entry) return reject()
      const sock = net.connect(entry.targetPort!, entry.targetHost!)
      sock.once('connect', () => pipeBoth(sock, accept()))
      sock.once('error', () => reject())
    })
  }
  const addr = e.bindAddress || '127.0.0.1'
  const map = routes
  return new Promise((resolve, reject) => {
    conn.client.forwardIn(addr, e.bindPort, (err, port) => {
      if (err) return reject(new Error(`Remote server refused to listen on ${addr}:${e.bindPort} (${err.message})`))
      map.set(port || e.bindPort, e)
      resolve({
        close: () =>
          new Promise<void>((r) => {
            map.delete(port || e.bindPort)
            if (conn.isClosed) return r()
            try {
              conn.client.unforwardIn(addr, e.bindPort, () => r())
            } catch {
              r()
            }
          })
      })
    })
  })
}

export function startForward(conn: SshConnection, e: ForwardEntry): Promise<RunningForward> {
  switch (e.type) {
    case 'local':
      return startLocal(conn, e)
    case 'remote':
      return startRemote(conn, e)
    case 'dynamic':
      return startDynamic(conn, e)
  }
}
