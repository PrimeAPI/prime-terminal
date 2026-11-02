// Minimal SOCKS5 server (no auth, CONNECT only) used for dynamic forwards (-D).

import net from 'node:net'
import type { Duplex } from 'node:stream'

export type SocksConnector = (host: string, port: number, src: net.Socket) => Promise<Duplex>

const REPLY_OK = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])

function parseRequest(buf: Buffer): { host: string; port: number; length: number } | 'incomplete' | 'bad' {
  if (buf.length < 5) return 'incomplete'
  if (buf[0] !== 5) return 'bad'
  const atyp = buf[3]
  let host: string
  let off: number
  if (atyp === 1) {
    if (buf.length < 10) return 'incomplete'
    host = Array.from(buf.subarray(4, 8)).join('.')
    off = 8
  } else if (atyp === 3) {
    const len = buf[4]
    if (buf.length < 5 + len + 2) return 'incomplete'
    host = buf.subarray(5, 5 + len).toString('utf8')
    off = 5 + len
  } else if (atyp === 4) {
    if (buf.length < 22) return 'incomplete'
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
    host = parts.join(':')
    off = 20
  } else return 'bad'
  return { host, port: buf.readUInt16BE(off), length: off + 2 }
}

export function createSocks5Server(connect: SocksConnector): net.Server {
  return net.createServer((sock) => {
    sock.on('error', () => sock.destroy())
    let stage: 'greeting' | 'request' | 'connecting' = 'greeting'
    let buf = Buffer.alloc(0)

    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (stage === 'greeting') {
        if (buf.length < 2) return
        const n = buf[1]
        if (buf[0] !== 5) return sock.destroy()
        if (buf.length < 2 + n) return
        const methods = buf.subarray(2, 2 + n)
        buf = buf.subarray(2 + n)
        if (!methods.includes(0)) {
          sock.end(Buffer.from([5, 0xff]))
          return
        }
        sock.write(Buffer.from([5, 0]))
        stage = 'request'
      }
      if (stage === 'request') {
        const req = parseRequest(buf)
        if (req === 'incomplete') return
        if (req === 'bad' || buf[1] !== 1) {
          sock.end(reply(req === 'bad' ? 1 : 7))
          return
        }
        const rest = buf.subarray(req.length)
        stage = 'connecting'
        sock.pause()
        sock.off('data', onData)
        connect(req.host, req.port, sock)
          .then((remote) => {
            sock.write(REPLY_OK)
            if (rest.length) remote.write(rest)
            remote.on('error', () => sock.destroy())
            remote.on('close', () => sock.destroy())
            sock.on('close', () => remote.destroy())
            sock.pipe(remote).pipe(sock)
            sock.resume()
          })
          .catch(() => sock.end(reply(5)))
      }
    }
    sock.on('data', onData)
  })
}
