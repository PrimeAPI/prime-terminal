import { useMemo, useState } from 'react'
import type { OpenTarget, Server, ServersDoc } from '../../../shared/types'
import { fuzzyFilter, parseAdhocTarget } from '../../../shared/fuzzy'

interface Props {
  servers: ServersDoc
  onOpen: (target: OpenTarget, newWindow: boolean) => void
  onClose: () => void
}

type Item = { kind: 'server'; server: Server } | { kind: 'adhoc'; save: boolean; text: string; target: ReturnType<typeof parseAdhocTarget> }

const sub = (s: Server) => (s.type === 'ssh' ? `${s.username}@${s.host}${s.port !== 22 ? ':' + s.port : ''}` : s.shell)

export function QuickConnect({ servers, onOpen, onClose }: Props) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)

  const items: Item[] = useMemo(() => {
    const visible = servers.servers.filter((s) => !(s.type === 'local' && s.hidden))
    const list: Item[] = fuzzyFilter(q, visible, (s) => `${s.name} ${s.type === 'ssh' ? s.host : ''}`).map((s) => ({
      kind: 'server' as const,
      server: s
    }))
    const adhoc = parseAdhocTarget(q)
    if (adhoc && !visible.some((s) => s.name === q.trim())) {
      list.push({ kind: 'adhoc', save: false, text: q.trim(), target: adhoc })
      list.push({ kind: 'adhoc', save: true, text: q.trim(), target: adhoc })
    }
    return list
  }, [q, servers])

  const open = (item: Item | undefined, newWindow: boolean) => {
    if (!item) return
    if (item.kind === 'server') onOpen({ serverId: item.server.id }, newWindow)
    else if (item.target) onOpen({ adhoc: item.target, save: item.save }, newWindow)
    onClose()
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="quick" role="dialog">
        <input
          autoFocus
          placeholder="Connect to… (server name or user@host:port)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(items.length - 1, s + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(0, s - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              open(items[sel], e.shiftKey)
            }
            e.stopPropagation()
          }}
        />
        <ul>
          {items.map((it, i) => (
            <li
              key={it.kind === 'server' ? it.server.id : `adhoc-${it.save}`}
              className={i === sel ? 'sel' : ''}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                open(it, e.shiftKey)
              }}
            >
              {it.kind === 'server' ? (
                <>
                  <span>{it.server.name}</span>
                  <span className="sub">{sub(it.server)}</span>
                </>
              ) : (
                <span>
                  {it.save ? 'Connect and save ' : 'Connect to '}
                  <b>{it.text}</b>
                </span>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="sub">No matching server</li>}
        </ul>
        <div className="footer-hint">
          <kbd>Enter</kbd> open in this window · <kbd>Shift</kbd>+<kbd>Enter</kbd> new window · <kbd>Esc</kbd> close
        </div>
      </div>
    </div>
  )
}
