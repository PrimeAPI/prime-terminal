// Terminal sessions (SSH shells and local PTYs) live here, independent of windows.
// Windows attach to a session by id; output is buffered so a tab can move between windows.

import { EventEmitter } from 'node:events'
import type { SessionState } from '../../shared/types'
import { newId } from '../../shared/ids'
import { RingBuffer } from './ringBuffer'

/** Events: 'data' (text), 'exit' (message?) */
export interface SessionBackend extends EventEmitter {
  start(cols: number, rows: number): Promise<void>
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

export interface SessionSpec {
  title: string
  kind: 'ssh' | 'local'
  serverId: string | null
  factory: () => SessionBackend
}

interface Session {
  id: string
  spec: SessionSpec
  state: SessionState
  backend: SessionBackend | null
  cols: number
  rows: number
  buffer: RingBuffer
}

const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
const BUFFER_CHARS = 2_000_000

/**
 * Events:
 *  - 'data'  (id, text)
 *  - 'state' (id, state)
 */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  create(spec: SessionSpec): string {
    const id = newId()
    this.sessions.set(id, { id, spec, state: 'closed', backend: null, cols: 80, rows: 24, buffer: new RingBuffer(BUFFER_CHARS) })
    return id
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  info(id: string): { spec: SessionSpec; state: SessionState } | undefined {
    const s = this.sessions.get(id)
    return s && { spec: s.spec, state: s.state }
  }

  ids(): string[] {
    return [...this.sessions.keys()]
  }

  private output(s: Session, text: string) {
    s.buffer.push(text)
    this.emit('data', s.id, text)
  }

  private setState(s: Session, state: SessionState) {
    s.state = state
    this.emit('state', s.id, state)
  }

  start(id: string): void {
    const s = this.sessions.get(id)
    if (!s || s.state !== 'closed') return
    const backend = s.spec.factory()
    s.backend = backend
    this.setState(s, 'connecting')
    if (s.spec.kind === 'ssh') this.output(s, `${DIM}Connecting to ${s.spec.title}…${RESET}\r\n`)

    backend.on('data', (d: string) => {
      if (s.backend === backend) this.output(s, d)
    })
    backend.once('exit', (message?: string) => {
      if (s.backend !== backend) return
      s.backend = null
      const hint =
        s.spec.kind === 'ssh' ? 'Connection closed – press Enter to reconnect' : 'Process exited – press Enter to restart'
      this.output(s, `\r\n${DIM}${message ? message + '. ' : ''}${hint}${RESET}\r\n`)
      this.setState(s, 'closed')
    })

    backend.start(s.cols, s.rows).then(
      () => {
        if (!this.sessions.has(id) || s.backend !== backend) {
          backend.close()
          return
        }
        if (s.state === 'connecting') this.setState(s, 'connected')
      },
      (err: Error) => {
        if (s.backend !== backend) return
        s.backend = null
        backend.close()
        if (!this.sessions.has(id)) return
        const hint = s.spec.kind === 'ssh' ? 'press Enter to reconnect' : 'press Enter to retry'
        this.output(s, `\r\n${RED}${err.message}${RESET}\r\n${DIM}${hint}${RESET}\r\n`)
        this.setState(s, 'closed')
      }
    )
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.state === 'closed') {
      if (data.includes('\r')) this.start(id)
      return
    }
    if (s.state === 'connected') s.backend?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s || cols < 1 || rows < 1) return
    s.cols = cols
    s.rows = rows
    if (s.state === 'connected') s.backend?.resize(cols, rows)
  }

  snapshot(id: string): string {
    return this.sessions.get(id)?.buffer.toString() ?? ''
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    const b = s.backend
    if (b && s.state === 'connected') {
      s.backend = null
      b.close()
    }
    // a backend still connecting is closed when its start() settles
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
