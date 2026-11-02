// Runs port-forwarding sets in the background (task.md 7.1).
// - initial connection failure: error, no retry
// - drop of an established connection: reconnect with exponential backoff
// - per-entry failures do not affect other entries

import { EventEmitter } from 'node:events'
import type { ForwardSet, SshServer, TunnelEntryStatus, TunnelSetStatus } from '../../shared/types'
import type { SshConnection } from '../ssh/connect'
import { startForward, type RunningForward } from './forwards'

export interface TunnelManagerDeps {
  getSet(id: string): ForwardSet | undefined
  resolveHops(set: ForwardSet): SshServer[]
  connect(hops: SshServer[]): Promise<SshConnection>
  /** seconds */
  backoff(): { min: number; max: number }
}

export function backoffDelay(attempt: number, min: number, max: number): number {
  return Math.min(max, min * 2 ** attempt)
}

class Runner {
  status: TunnelSetStatus
  private conn: SshConnection | null = null
  private running: RunningForward[] = []
  private timer: NodeJS.Timeout | null = null
  private attempt = 0
  stopped = false

  constructor(
    private readonly set: ForwardSet,
    private readonly deps: TunnelManagerDeps,
    private readonly emit: (s: TunnelSetStatus) => void
  ) {
    this.status = {
      setId: set.id,
      state: 'connecting',
      entries: set.forwards.map((f) => ({ id: f.id, state: 'off' }))
    }
  }

  private update(patch: Partial<TunnelSetStatus>) {
    this.status = { ...this.status, ...patch }
    if (!('error' in patch) && patch.state && patch.state !== 'error') delete this.status.error
    if (patch.state !== 'reconnecting') delete this.status.nextRetryAt
    this.emit(this.status)
  }

  async start(): Promise<void> {
    let hops: SshServer[]
    try {
      hops = this.deps.resolveHops(this.set)
    } catch (e) {
      this.update({ state: 'error', error: (e as Error).message })
      return
    }
    this.update({ state: 'connecting' })
    try {
      const conn = await this.deps.connect(hops)
      if (this.stopped) return conn.close()
      await this.attach(conn)
    } catch (e) {
      if (!this.stopped) this.update({ state: 'error', error: (e as Error).message })
    }
  }

  private async attach(conn: SshConnection) {
    this.conn = conn
    this.attempt = 0
    conn.once('close', () => this.onDrop(conn))
    const entries: TunnelEntryStatus[] = await Promise.all(
      this.set.forwards.map(async (f): Promise<TunnelEntryStatus> => {
        if (!f.enabled) return { id: f.id, state: 'off' }
        try {
          const r = await startForward(conn, f)
          if (this.stopped || conn.isClosed) {
            await r.close()
            return { id: f.id, state: 'off' }
          }
          this.running.push(r)
          return { id: f.id, state: 'active' }
        } catch (e) {
          return { id: f.id, state: 'error', error: (e as Error).message }
        }
      })
    )
    if (this.stopped || conn.isClosed) return
    this.update({ state: 'active', entries })
  }

  private async closeForwards() {
    const r = this.running.splice(0)
    await Promise.all(r.map((f) => f.close().catch(() => {})))
  }

  private async onDrop(conn: SshConnection) {
    if (this.conn !== conn) return
    this.conn = null
    await this.closeForwards()
    if (this.stopped) return
    this.scheduleReconnect(conn.lastError?.message)
  }

  private scheduleReconnect(reason?: string) {
    const { min, max } = this.deps.backoff()
    const delay = backoffDelay(this.attempt++, min, max) * 1000
    this.update({
      state: 'reconnecting',
      nextRetryAt: Date.now() + delay,
      error: reason,
      entries: this.status.entries.map((e) => ({ id: e.id, state: 'off' as const }))
    })
    this.status.nextRetryAt = Date.now() + delay
    this.timer = setTimeout(() => void this.reconnect(), delay)
  }

  private async reconnect() {
    this.timer = null
    if (this.stopped) return
    try {
      const conn = await this.deps.connect(this.deps.resolveHops(this.set))
      if (this.stopped) return conn.close()
      await this.attach(conn)
    } catch (e) {
      if (!this.stopped) this.scheduleReconnect((e as Error).message)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const conn = this.conn
    this.conn = null
    await this.closeForwards()
    conn?.close()
  }
}

export class TunnelManager extends EventEmitter {
  private runners = new Map<string, Runner>()
  private last = new Map<string, TunnelSetStatus>()

  constructor(private readonly deps: TunnelManagerDeps) {
    super()
  }

  private publish(s: TunnelSetStatus) {
    this.last.set(s.setId, s)
    this.emit('change', s)
  }

  /** Resolves once the initial attempt finished (active or error). */
  async activate(setId: string): Promise<void> {
    const set = this.deps.getSet(setId)
    if (!set) throw new Error(`Unknown set ${setId}`)
    await this.runners.get(setId)?.stop()
    // snapshot: later edits apply only after re-activation
    const snapshot: ForwardSet = structuredClone(set)
    const runner = new Runner(snapshot, this.deps, (s) => {
      if (this.runners.get(setId) === runner) this.publish(s)
    })
    this.runners.set(setId, runner)
    await runner.start()
  }

  async deactivate(setId: string): Promise<void> {
    const r = this.runners.get(setId)
    this.runners.delete(setId)
    if (r) await r.stop()
    const set = this.deps.getSet(setId)
    this.publish({ setId, state: 'off', entries: (set?.forwards ?? []).map((f) => ({ id: f.id, state: 'off' })) })
  }

  isRunning(setId: string): boolean {
    return this.runners.has(setId)
  }

  status(setId: string): TunnelSetStatus {
    if (this.runners.has(setId)) return this.runners.get(setId)!.status
    const set = this.deps.getSet(setId)
    const last = this.last.get(setId)
    if (last && last.state === 'error') return last
    return { setId, state: 'off', entries: (set?.forwards ?? []).map((f) => ({ id: f.id, state: 'off' })) }
  }

  /** Remove error state of a set that is not running. */
  clear(setId: string) {
    if (!this.runners.has(setId)) this.last.delete(setId)
  }

  async stopAll(): Promise<void> {
    const all = [...this.runners.keys()]
    await Promise.all(all.map((id) => this.deactivate(id)))
  }
}
