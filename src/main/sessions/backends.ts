import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel } from 'ssh2'
import type { LocalServer, SshServer } from '../../shared/types'
import { expandHome } from '../ssh/auth'
import type { SshConnection } from '../ssh/connect'
import type { SessionBackend } from './sessionManager'

/** Interactive SSH shell (with PTY) on the last hop. */
export class SshShellBackend extends EventEmitter implements SessionBackend {
  private conn: SshConnection | null = null
  private channel: ClientChannel | null = null
  private exited = false

  constructor(
    private readonly hops: () => SshServer[],
    private readonly connect: (hops: SshServer[]) => Promise<SshConnection>
  ) {
    super()
  }

  async start(cols: number, rows: number): Promise<void> {
    const conn = await this.connect(this.hops())
    this.conn = conn
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      conn.client.shell({ term: 'xterm-256color', cols, rows }, (err, ch) => (err ? reject(err) : resolve(ch)))
    ).catch((e) => {
      conn.close()
      throw e
    })
    this.channel = channel
    const out = new StringDecoder('utf8')
    const err = new StringDecoder('utf8')
    channel.on('data', (d: Buffer) => this.emit('data', out.write(d)))
    channel.stderr.on('data', (d: Buffer) => this.emit('data', err.write(d)))
    channel.on('close', () => this.exit())
    conn.on('close', (e: Error | null) => this.exit(e ? `Connection lost: ${e.message}` : undefined))
  }

  private exit(message?: string) {
    if (this.exited) return
    this.exited = true
    this.conn?.close()
    this.emit('exit', message)
  }

  write(data: string): void {
    this.channel?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.channel?.setWindow(rows, cols, 0, 0)
  }

  close(): void {
    this.exited = true
    this.channel?.close()
    this.conn?.close()
  }
}

type Pty = import('node-pty').IPty

/** Local shell via node-pty (ConPTY on Windows). */
export class LocalPtyBackend extends EventEmitter implements SessionBackend {
  private pty: Pty | null = null
  private closing = false

  constructor(private readonly server: LocalServer) {
    super()
  }

  async start(cols: number, rows: number): Promise<void> {
    const pty = await import('node-pty')
    const home = homedir()
    let cwd = this.server.cwd ? expandHome(this.server.cwd, home) : home
    if (!existsSync(cwd)) cwd = home
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    const p = pty.spawn(this.server.shell, this.server.args ?? [], { name: 'xterm-256color', cols, rows, cwd, env })
    this.pty = p
    p.onData((d) => this.emit('data', d))
    p.onExit(({ exitCode }) => {
      this.pty = null
      if (!this.closing) this.emit('exit', `Process exited with code ${exitCode}`)
    })
  }

  write(data: string): void {
    this.pty?.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows)
    } catch {
      // resizing an exiting pty can throw
    }
  }

  close(): void {
    this.closing = true
    try {
      this.pty?.kill()
    } catch {
      // already gone
    }
    this.pty = null
  }
}
