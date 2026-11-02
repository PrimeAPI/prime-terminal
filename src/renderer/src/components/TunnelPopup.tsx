import { useEffect, useRef, useState } from 'react'
import type { ConfigSnapshot, TunnelSetStatus } from '../../../shared/types'
import { pt } from '../lib/api'
import { useTicker } from '../lib/hooks'

interface Props {
  config: ConfigSnapshot
  status: Record<string, TunnelSetStatus>
  onManage: () => void
  onClose: () => void
}

export function describeStatus(s: TunnelSetStatus | undefined, now = Date.now()): string {
  if (!s) return 'off'
  switch (s.state) {
    case 'off':
      return 'off'
    case 'connecting':
      return 'connecting…'
    case 'active': {
      const enabled = s.entries.filter((e) => e.state !== 'off')
      const ok = enabled.filter((e) => e.state === 'active').length
      return ok === enabled.length ? `active · ${ok} forward${ok === 1 ? '' : 's'}` : `active · ${ok}/${enabled.length} ok`
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

export function TunnelPopup({ config, status, onManage, onClose }: Props) {
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

  const servers = config.servers.servers
  const sets = config.sets.sets

  return (
    <div className="tunnel-popup" ref={ref}>
      {sets.length === 0 && <div className="empty">No port forwarding sets yet.</div>}
      {sets.map((set) => {
        const s = status[set.id]
        const on = !!s && s.state !== 'off' && s.state !== 'error'
        const server = servers.find((x) => x.id === set.server)
        const open = expanded[set.id] ?? (s?.state === 'error' || s?.entries.some((e) => e.state === 'error'))
        return (
          <div className="set" key={set.id}>
            <div className="set-row">
              <button
                className={'switch' + (on ? ' on' : '')}
                role="switch"
                aria-checked={on}
                title={on ? 'Deactivate' : 'Activate'}
                onClick={() => void (on ? pt.tunnels.deactivate(set.id) : pt.tunnels.activate(set.id))}
              />
              <div className="info" onClick={() => setExpanded({ ...expanded, [set.id]: !open })}>
                <div className="name">{set.name || '(unnamed)'}</div>
                <div className="sub">
                  <span className={'state-dot ' + (s?.state ?? 'off')} style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 5 }} />
                  {describeStatus(s)} · {server ? server.name : set.unresolvedServer ? `unresolved: ${set.unresolvedServer}` : 'no server'}
                </div>
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
