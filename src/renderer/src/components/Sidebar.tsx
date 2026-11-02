import { useMemo, useState } from 'react'
import type { Folder, Server, ServersDoc } from '../../../shared/types'
import { fuzzyFilter } from '../../../shared/fuzzy'
import { newId } from '../../../shared/ids'
import { pt } from '../lib/api'
import { useLocalStorage } from '../lib/hooks'

interface Props {
  doc: ServersDoc
  onOpen: (serverId: string, newWindow: boolean) => void
  onEdit: (server: Server | null, folderId?: string) => void
  onRenameFolder: (folder: Folder | null) => void
  notify: (msg: string, error?: boolean) => void
}

const SERVER_MIME = 'application/x-prime-server'
const UNGROUPED = '__ungrouped'
const LOCAL = '__local'

const sub = (s: Server) => (s.type === 'ssh' ? `${s.username}@${s.host}${s.port !== 22 ? ':' + s.port : ''}` : s.shell)

export function Sidebar({ doc, onOpen, onEdit, onRenameFolder, notify }: Props) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useLocalStorage<Record<string, boolean>>('sidebar.collapsed', {})
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const save = async (next: ServersDoc) => {
    const r = await pt.config.saveServers(next)
    if (!r.ok) notify(r.error, true)
  }

  const groups = useMemo(() => {
    const matches = new Set(fuzzyFilter(q, doc.servers, (s) => `${s.name} ${s.type === 'ssh' ? s.host : ''}`).map((s) => s.id))
    const visible = doc.servers.filter((s) => matches.has(s.id) && (showHidden || !(s.type === 'local' && s.hidden)))
    const byFolder = (fid: string) => visible.filter((s) => s.folderId === fid)
    const out: { key: string; folder: Folder | null; title: string; servers: Server[] }[] = doc.folders.map((f) => ({
      key: f.id,
      folder: f,
      title: f.name,
      servers: byFolder(f.id)
    }))
    const known = new Set(doc.folders.map((f) => f.id))
    out.push({
      key: UNGROUPED,
      folder: null,
      title: 'Servers',
      servers: visible.filter((s) => s.type === 'ssh' && (!s.folderId || !known.has(s.folderId)))
    })
    out.push({
      key: LOCAL,
      folder: null,
      title: 'Local',
      servers: visible.filter((s) => s.type === 'local' && (!s.folderId || !known.has(s.folderId)))
    })
    return out
  }, [doc, q, showHidden])

  const hiddenCount = doc.servers.filter((s) => s.type === 'local' && s.hidden).length

  const serverMenu = async (s: Server) => {
    const items = [
      { id: 'open', label: 'Connect' },
      { id: 'openwin', label: 'Connect in new window' },
      { type: 'separator' as const },
      { id: 'edit', label: 'Edit…' },
      { id: 'dup', label: 'Duplicate' }
    ]
    if (s.type === 'ssh' && s.proxyJump?.chain.length) {
      items.push({ type: 'separator' as const }, { id: 'jump', label: 'Use proxy jump', type: 'checkbox', checked: s.proxyJump.enabled } as never)
    }
    items.push({ type: 'separator' as const })
    if (s.type === 'local' && s.autoDetected) items.push({ id: 'hide', label: s.hidden ? 'Show' : 'Hide' })
    else items.push({ id: 'delete', label: 'Delete' })
    const r = await pt.ui.contextMenu(items)
    if (r === 'open') onOpen(s.id, false)
    else if (r === 'openwin') onOpen(s.id, true)
    else if (r === 'edit') onEdit(s)
    else if (r === 'dup') {
      const copy = { ...structuredClone(s), id: newId(), name: `${s.name} (copy)` } as Server
      if (copy.type === 'local') delete copy.autoDetected
      await save({ ...doc, servers: [...doc.servers, copy] })
    } else if (r === 'jump' && s.type === 'ssh' && s.proxyJump) {
      await save({
        ...doc,
        servers: doc.servers.map((x) => (x.id === s.id && x.type === 'ssh' ? { ...x, proxyJump: { ...s.proxyJump!, enabled: !s.proxyJump!.enabled } } : x))
      })
    } else if (r === 'hide' && s.type === 'local') {
      await save({ ...doc, servers: doc.servers.map((x) => (x.id === s.id ? { ...x, hidden: !s.hidden } : x)) })
    } else if (r === 'delete') {
      const usedBy = doc.servers.filter((x) => x.type === 'ssh' && x.proxyJump?.chain.includes(s.id))
      const msg = usedBy.length
        ? `Delete "${s.name}"? It is used as jump host by: ${usedBy.map((x) => x.name).join(', ')}. It will be removed from their jump chains.`
        : `Delete "${s.name}"?`
      if (!confirm(msg)) return
      await save({
        ...doc,
        servers: doc.servers
          .filter((x) => x.id !== s.id)
          .map((x) =>
            x.type === 'ssh' && x.proxyJump?.chain.includes(s.id)
              ? { ...x, proxyJump: { ...x.proxyJump, chain: x.proxyJump.chain.filter((c) => c !== s.id) } }
              : x
          )
      })
    }
  }

  const folderMenu = async (f: Folder) => {
    const r = await pt.ui.contextMenu([
      { id: 'new', label: 'New server in folder…' },
      { id: 'rename', label: 'Rename…' },
      { id: 'delete', label: 'Delete folder' }
    ])
    if (r === 'new') onEdit(null, f.id)
    else if (r === 'rename') onRenameFolder(f)
    else if (r === 'delete') {
      if (!confirm(`Delete folder "${f.name}"? Its servers are kept.`)) return
      await save({
        folders: doc.folders.filter((x) => x.id !== f.id),
        servers: doc.servers.map((s) => (s.folderId === f.id ? (({ folderId: _f, ...rest }) => rest as Server)(s) : s))
      })
    }
  }

  const moveToFolder = async (serverId: string, groupKey: string) => {
    const folderId = groupKey === UNGROUPED || groupKey === LOCAL ? undefined : groupKey
    await save({
      ...doc,
      servers: doc.servers.map((s) => {
        if (s.id !== serverId) return s
        const { folderId: _old, ...rest } = s
        return (folderId ? { ...rest, folderId } : rest) as Server
      })
    })
  }

  const importConfig = async () => {
    const r = await pt.config.importSshConfig()
    if (!r.ok) return notify(r.error, true)
    notify(`Imported ${r.added} server${r.added === 1 ? '' : 's'} from ~/.ssh/config${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}`)
  }

  return (
    <aside className="sidebar">
      <div className="search">
        <input
          placeholder="Search servers"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('')
            if (e.key === 'Enter') {
              const first = groups.flatMap((g) => g.servers)[0]
              if (first) onOpen(first.id, e.shiftKey)
            }
          }}
        />
      </div>
      <div className="tree" tabIndex={-1}>
        {groups.map((g) => {
          if (!g.folder && g.servers.length === 0 && g.key === UNGROUPED && doc.folders.length > 0) return null
          const isCollapsed = !q && collapsed[g.key]
          return (
            <div key={g.key}>
              <div
                className={'group-header' + (dropTarget === g.key ? ' drop-target' : '')}
                onClick={() => setCollapsed({ ...collapsed, [g.key]: !collapsed[g.key] })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (g.folder) void folderMenu(g.folder)
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(SERVER_MIME)) return
                  e.preventDefault()
                  setDropTarget(g.key)
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(SERVER_MIME)
                  setDropTarget(null)
                  if (id) void moveToFolder(id, g.key)
                }}
              >
                <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
                <span style={{ flex: 1 }}>{g.title}</span>
                {g.key === LOCAL && hiddenCount > 0 && (
                  <button
                    className="icon"
                    style={{ fontSize: 10, textTransform: 'none' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowHidden(!showHidden)
                    }}
                  >
                    {showHidden ? 'hide hidden' : `+${hiddenCount} hidden`}
                  </button>
                )}
              </div>
              {!isCollapsed &&
                g.servers.map((s) => (
                  <div
                    key={s.id}
                    className={'item' + (selected === s.id ? ' selected' : '')}
                    draggable
                    title={sub(s)}
                    onClick={() => setSelected(s.id)}
                    onDoubleClick={(e) => onOpen(s.id, e.shiftKey)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setSelected(s.id)
                      void serverMenu(s)
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(SERVER_MIME, s.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onOpen(s.id, e.shiftKey)
                      if (e.key === 'F2') onEdit(s)
                    }}
                  >
                    <span className="name">
                      {s.name}
                      {s.type === 'ssh' && s.proxyJump?.enabled && s.proxyJump.chain.length > 0 && <span className="badge">jump</span>}
                      {s.type === 'local' && s.hidden && <span className="badge">hidden</span>}
                    </span>
                    <span className="sub">{sub(s)}</span>
                  </div>
                ))}
            </div>
          )
        })}
      </div>
      <div className="footer">
        <button onClick={() => onEdit(null)} title="New server">
          + Server
        </button>
        <button onClick={() => onRenameFolder(null)} title="New folder">
          + Folder
        </button>
        <button onClick={() => void importConfig()} title="Import hosts from ~/.ssh/config">
          Import
        </button>
      </div>
    </aside>
  )
}
