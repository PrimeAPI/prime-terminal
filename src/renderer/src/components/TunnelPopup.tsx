import { useEffect, useRef, useState } from 'react'
import { isTunnelRunning, type ConfigSnapshot, type ForwardSet, type TunnelSetStatus } from '../../../shared/types'
import { pt } from '../lib/api'
import { useTicker } from '../lib/hooks'

interface Props {
  config: ConfigSnapshot
  status: Record<string, TunnelSetStatus>
  onManage: () => void
  onClose: () => void
  notify: (msg: string, error?: boolean) => void
}

export function describeStatus(s: TunnelSetStatus | undefined, now = Date.now()): string {
  if (!s) return 'stopped'
  switch (s.state) {
    case 'off':
      return 'stopped'
    case 'connecting':
      return 'connecting…'
    case 'active': {
      const enabled = s.entries.filter((e) => e.state !== 'off')
      const ok = enabled.filter((e) => e.state === 'active').length
      return ok === enabled.length ? `running · ${ok} forward${ok === 1 ? '' : 's'}` : `running · ${ok}/${enabled.length} ok`
    }
    case 'reconnecting': {
      const secs = s.nextRetryAt ? Math.max(0, Math.ceil((s.nextRetryAt - now) / 1000)) : 0
      return secs > 0 ? `reconnecting in ${secs}s` : 'reconnecting…'
    }
    case 'error':
      return 'error'
  }
}

export function overallState(status: Record<string, TunnelSetStatus>): 'off' | 'active' | 'reconnecting' | 'error' {
  const all = Object.values(status)
  if (all.some((s) => s.state === 'error' || (s.state === 'active' && s.entries.some((e) => e.state === 'error')))) return 'error'
  if (all.some((s) => s.state === 'reconnecting' || s.state === 'connecting')) return 'reconnecting'
  if (all.some((s) => s.state === 'active')) return 'active'
  return 'off'
}

function fwdLabel(f: { type: string; bindAddress?: string; bindPort: number; targetHost?: string; targetPort?: number; name?: string }) {
  const bind = `${f.bindAddress && f.bindAddress !== '127.0.0.1' ? f.bindAddress + ':' : ''}${f.bindPort}`
  const flag = f.type === 'local' ? 'L' : f.type === 'remote' ? 'R' : 'D'
  const tgt = f.type === 'dynamic' ? 'SOCKS' : `${f.targetHost}:${f.targetPort}`
  return `${f.name ? f.name + ' · ' : ''}${flag} ${bind} → ${tgt}`
}

/** Save a change to one set without opening the set manager. */
export async function patchSet(config: ConfigSnapshot, id: string, patch: (s: ForwardSet) => ForwardSet): Promise<string | null> {
  const r = await pt.config.saveSets({ sets: config.sets.sets.map((s) => (s.id === id ? patch(structuredClone(s)) : s)) })
  return r.ok ? null : r.error
}

export function routeLabel(set: ForwardSet, config: ConfigSnapshot): string {
  const servers = config.servers.servers
  const name = (id: string) => servers.find((x) => x.id === id)?.name ?? '?'
  const target = servers.find((x) => x.id === set.server)
  if (!target) return set.unresolvedServer ? `server not found: ${set.unresolvedServer}` : 'no server'
  const chain =
    set.proxyJump ?? (target.type === 'ssh' && target.proxyJump?.enabled ? target.proxyJump.chain : [])
  return [...chain.map(name), target.name].join(' → ')
}

export function TunnelPopup({ config, status, onManage, onClose, notify }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const reconnecting = Object.values(status).some((s) => s.state === 'reconnecting')
  useTicker(reconnecting)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (ref.current && !ref.current.contains(t) && !t.closest('[data-tunnel-button]')) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const sets = config.sets.sets
  const running = sets.filter((s) => isTunnelRunning(status[s.id]))

  const toggleFlag = async (set: ForwardSet, flag: 'autoStart' | 'autoReconnect') => {
    const err = await patchSet(config, set.id, (s) => {
      if (flag === 'autoStart') {
        if (s.autoStart) delete s.autoStart
        else s.autoStart = true
      } else if (s.autoReconnect === false) delete s.autoReconnect
      else s.autoReconnect = false
      return s
    })
    if (err) notify(err, true)
  }

  return (
    <div className="tunnel-popup" ref={ref}>
      <div className="tp-header">
        <span>Port forwarding</span>
        <span style={{ flex: 1 }} />
        <button disabled={running.length === sets.length || sets.length === 0} onClick={() => sets.filter((s) => !isTunnelRunning(status[s.id])).forEach((s) => void pt.tunnels.activate(s.id))}>
          Start all
        </button>
        <button disabled={running.length === 0} onClick={() => running.forEach((s) => void pt.tunnels.deactivate(s.id))}>
          Stop all
        </button>
      </div>
      {sets.length === 0 && <div className="empty">No port forwarding sets yet.</div>}
      {sets.map((set) => {
        const s = status[set.id]
        const on = isTunnelRunning(s)
        const open = expanded[set.id] ?? (s?.state === 'error' || !!s?.entries.some((e) => e.state === 'error'))
        return (
          <div className="set" key={set.id}>
            <div className="set-row">
              <button
                className={'run-btn' + (on ? ' on' : '')}
                title={on ? 'Stop' : 'Start'}
                onClick={() => void (on ? pt.tunnels.deactivate(set.id) : pt.tunnels.activate(set.id))}
              >
                {on ? '■' : '▶'}
              </button>
              <div className="info" onClick={() => setExpanded({ ...expanded, [set.id]: !open })}>
                <div className="name">
                  <span className={'state-dot ' + (s?.state ?? 'off')} />
                  {set.name || '(unnamed)'}
                  <span className="sub" style={{ marginLeft: 6 }}>
                    {describeStatus(s)}
                  </span>
                </div>
                <div className="sub">{routeLabel(set, config)}</div>
              </div>
              <div className="flags">
                <button className={'chip' + (set.autoStart ? ' on' : '')} title="Start this set when the app starts" onClick={() => void toggleFlag(set, 'autoStart')}>
                  auto-start
                </button>
                <button
                  className={'chip' + (set.autoReconnect !== false ? ' on' : '')}
                  title="Reconnect automatically when the connection drops"
                  onClick={() => void toggleFlag(set, 'autoReconnect')}
                >
                  reconnect
                </button>
              </div>
              <button className="icon" onClick={() => setExpanded({ ...expanded, [set.id]: !open })} title="Details">
                {open ? '▾' : '▸'}
              </button>
            </div>
            {open && (
              <div className="entries">
                {s?.error && <div className="error-text" style={{ marginBottom: 4 }}>{s.error}</div>}
                {set.forwards.length === 0 && <div className="hint">No forwards in this set.</div>}
                {set.forwards.map((f) => {
                  const es = s?.entries.find((e) => e.id === f.id)
                  const st = !f.enabled ? 'off' : (es?.state ?? 'off')
                  return (
                    <div className="entry" key={f.id} style={{ opacity: f.enabled ? 1 : 0.5 }}>
                      <span className={'state-dot ' + st} />
                      <div>
                        <div className="mono">{fwdLabel(f)}</div>
                        {es?.error && <div className="error-text">{es.error}</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      <div className="footer">
        <button
          onClick={() => {
            onManage()
            onClose()
          }}
        >
          Manage sets…
        </button>
      </div>
    </div>
  )
}
