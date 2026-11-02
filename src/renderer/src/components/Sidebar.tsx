import { useMemo, useState, type ReactNode } from 'react'
import type { Folder, MenuItemSpec, Server, ServersDoc } from '../../../shared/types'
import { fuzzyFilter } from '../../../shared/fuzzy'
import { deleteFolder, folderTree, isDescendant, moveFolder, moveServers, type FolderNode } from '../../../shared/folders'
import { newId } from '../../../shared/ids'
import { pt } from '../lib/api'
import { useLocalStorage } from '../lib/hooks'

/** Items in the tree are referenced as "s:<serverId>" or "f:<folderId>". */
export type ItemKey = string
export const serverKey = (id: string) => `s:${id}`
export const folderKey = (id: string) => `f:${id}`
const idOf = (k: ItemKey) => k.slice(2)

interface Props {
  doc: ServersDoc
  onOpen: (serverId: string, newWindow: boolean) => void
  onEdit: (server: Server | null, folderId?: string) => void
  onFolderDialog: (folder: Folder | null, parentId?: string) => void
  onMove: (items: ItemKey[]) => void
  notify: (msg: string, error?: boolean) => void
}

const DRAG_MIME = 'application/x-prime-items'
const ROOT = '__root'

const sub = (s: Server) => (s.type === 'ssh' ? `${s.username}@${s.host}${s.port !== 22 ? ':' + s.port : ''}` : s.shell)

/** Move servers and folders; folders that would end up inside themselves are skipped. */
export function moveItems(doc: ServersDoc, items: ItemKey[], target: string | null): { doc: ServersDoc; skipped: number } {
  let next = moveServers(
    doc,
    items.filter((k) => k.startsWith('s:')).map(idOf),
    target
  )
  let skipped = 0
  for (const k of items.filter((x) => x.startsWith('f:'))) {
    try {
      next = moveFolder(next, idOf(k), target)
    } catch {
      skipped++
    }
  }
  return { doc: next, skipped }
}

function pruneEmpty(nodes: FolderNode[]): FolderNode[] {
  return nodes
    .map((n) => ({ ...n, children: pruneEmpty(n.children) }))
    .filter((n) => n.servers.length > 0 || n.children.length > 0)
}

export function Sidebar({ doc, onOpen, onEdit, onFolderDialog, onMove, notify }: Props) {
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useLocalStorage<Record<string, boolean>>('sidebar.collapsed', {})
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<ItemKey[]>([])
  const [anchor, setAnchor] = useState<ItemKey | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const save = async (next: ServersDoc) => {
    const r = await pt.config.saveServers(next)
    if (!r.ok) notify(r.error, true)
    return r.ok
  }

  const visibleServers = useMemo(() => {
    const base = doc.servers.filter((s) => showHidden || !(s.type === 'local' && s.hidden))
    return q ? fuzzyFilter(q, base, (s) => `${s.name} ${s.type === 'ssh' ? s.host : ''}`) : base
  }, [doc, q, showHidden])

  const tree = useMemo(() => {
    const t = folderTree(doc, visibleServers)
    return q ? { ...t, folders: pruneEmpty(t.folders) } : t
  }, [doc, visibleServers, q])

  const topSsh = tree.servers.filter((s) => s.type === 'ssh')
  const topLocal = tree.servers.filter((s) => s.type === 'local')
  const hiddenCount = doc.servers.filter((s) => s.type === 'local' && s.hidden).length
  const isCollapsed = (key: string) => !q && !!collapsed[key]

  // flattened visible order, for Shift-range selection
  const order = useMemo(() => {
    const out: ItemKey[] = []
    const walk = (n: FolderNode) => {
      out.push(folderKey(n.folder.id))
      if (isCollapsed(n.folder.id)) return
      n.children.forEach(walk)
      n.servers.forEach((s) => out.push(serverKey(s.id)))
    }
    tree.folders.forEach(walk)
    if (!isCollapsed(ROOT)) topSsh.forEach((s) => out.push(serverKey(s.id)))
    if (!isCollapsed('__local')) topLocal.forEach((s) => out.push(serverKey(s.id)))
    return out
  }, [tree, collapsed, q])

  const select = (e: React.MouseEvent, key: ItemKey) => {
    if (e.shiftKey && anchor) {
      const [a, b] = [order.indexOf(anchor), order.indexOf(key)].sort((x, y) => x - y)
      if (a >= 0) return setSelected(order.slice(a, b + 1))
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key])
    } else setSelected([key])
    setAnchor(key)
  }

  // ---------- actions ----------

  const drop = async (items: ItemKey[], target: string | null) => {
    const r = moveItems(doc, items, target)
    if (r.skipped) notify(`${r.skipped} folder${r.skipped > 1 ? 's' : ''} cannot be moved into ${r.skipped > 1 ? 'themselves' : 'itself'}`, true)
    if (target) setCollapsed({ ...collapsed, [target]: false })
    await save(r.doc)
  }

  const deleteItems = async (items: ItemKey[]) => {
    const serverIds = new Set(items.filter((k) => k.startsWith('s:')).map(idOf))
    const folderIds = items.filter((k) => k.startsWith('f:')).map(idOf)
    const autoLocal = doc.servers.filter((s) => serverIds.has(s.id) && s.type === 'local' && s.autoDetected)
    for (const s of autoLocal) serverIds.delete(s.id)
    const names = [
      ...folderIds.map((id) => `folder "${doc.folders.find((f) => f.id === id)?.name}"`),
      ...doc.servers.filter((s) => serverIds.has(s.id)).map((s) => `"${s.name}"`)
    ]
    if (!names.length) return
    const usedAsJump = doc.servers.filter((x) => x.type === 'ssh' && !serverIds.has(x.id) && x.proxyJump?.chain.some((c) => serverIds.has(c)))
    const msg =
      `Delete ${names.length > 3 ? `${names.length} items` : names.join(', ')}?` +
      (folderIds.length ? '\nContents of deleted folders move one level up.' : '') +
      (usedAsJump.length ? `\nUsed as jump host by: ${usedAsJump.map((x) => x.name).join(', ')} (removed from their chains).` : '')
    if (!confirm(msg)) return
    let next: ServersDoc = {
      ...doc,
      servers: doc.servers
        .filter((x) => !serverIds.has(x.id))
        .map((x) =>
          x.type === 'ssh' && x.proxyJump?.chain.some((c) => serverIds.has(c))
            ? { ...x, proxyJump: { ...x.proxyJump, chain: x.proxyJump.chain.filter((c) => !serverIds.has(c)) } }
            : x
        )
    }
    for (const id of folderIds) next = deleteFolder(next, id)
    if (await save(next)) setSelected([])
  }

  const itemsFor = (key: ItemKey) => (selected.includes(key) && selected.length > 1 ? selected : [key])

  const serverMenu = async (s: Server) => {
    const key = serverKey(s.id)
    const items = itemsFor(key)
    if (items.length > 1) return multiMenu(items)
    const menu: MenuItemSpec[] = [
      { id: 'open', label: 'Connect' },
      { id: 'openwin', label: 'Connect in new window' },
      { type: 'separator' },
      { id: 'edit', label: 'Edit…' },
      { id: 'dup', label: 'Duplicate' },
      { id: 'move', label: 'Move to…' }
    ]
    if (s.type === 'ssh' && s.proxyJump?.chain.length) {
      menu.push({ type: 'separator' }, { id: 'jump', label: 'Use proxy jump', type: 'checkbox', checked: s.proxyJump.enabled })
    }
    menu.push({ type: 'separator' })
    if (s.type === 'local' && s.autoDetected) menu.push({ id: 'hide', label: s.hidden ? 'Show' : 'Hide' })
    else menu.push({ id: 'delete', label: 'Delete' })
    const r = await pt.ui.contextMenu(menu)
    if (r === 'open') onOpen(s.id, false)
    else if (r === 'openwin') onOpen(s.id, true)
    else if (r === 'edit') onEdit(s)
    else if (r === 'move') onMove([key])
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
    } else if (r === 'delete') await deleteItems([key])
  }

  const folderMenu = async (f: Folder) => {
    const key = folderKey(f.id)
    const items = itemsFor(key)
    if (items.length > 1) return multiMenu(items)
    const r = await pt.ui.contextMenu([
      { id: 'new', label: 'New server here…' },
      { id: 'sub', label: 'New subfolder…' },
      { type: 'separator' },
      { id: 'rename', label: 'Rename…' },
      { id: 'move', label: 'Move to…' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete folder' }
    ])
    if (r === 'new') onEdit(null, f.id)
    else if (r === 'sub') onFolderDialog(null, f.id)
    else if (r === 'rename') onFolderDialog(f)
    else if (r === 'move') onMove([key])
    else if (r === 'delete') await deleteItems([key])
  }

  const multiMenu = async (items: ItemKey[]) => {
    const r = await pt.ui.contextMenu([
      { id: 'move', label: `Move ${items.length} items to…` },
      { id: 'delete', label: `Delete ${items.length} items` }
    ])
    if (r === 'move') onMove(items)
    else if (r === 'delete') await deleteItems(items)
  }

  // ---------- drag & drop ----------

  const dragProps = (key: ItemKey) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      const items = selected.includes(key) ? selected : [key]
      if (!selected.includes(key)) setSelected([key])
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(items))
      e.dataTransfer.effectAllowed = 'move'
    }
  })

  const dropProps = (target: string | null) => {
    const id = target ?? ROOT
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return
        e.preventDefault()
        e.stopPropagation()
        if (dropTarget !== id) setDropTarget(id)
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropTarget(null)
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setDropTarget(null)
        try {
          const items = JSON.parse(e.dataTransfer.getData(DRAG_MIME)) as ItemKey[]
          if (items.length) void drop(items, target)
        } catch {
          // not ours
        }
      }
    }
  }

  // ---------- rendering ----------

  const toggle = (key: string) => setCollapsed({ ...collapsed, [key]: !collapsed[key] })

  const serverRow = (s: Server, depth: number) => {
    const key = serverKey(s.id)
    return (
      <div
        key={s.id}
        className={'item' + (selected.includes(key) ? ' selected' : '')}
        style={{ paddingLeft: 22 + depth * 14 }}
        title={sub(s)}
        tabIndex={0}
        {...dragProps(key)}
        onClick={(e) => select(e, key)}
        onDoubleClick={(e) => onOpen(s.id, e.shiftKey)}
        onContextMenu={(e) => {
          e.preventDefault()
          if (!selected.includes(key)) setSelected([key])
          void serverMenu(s)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpen(s.id, e.shiftKey)
          if (e.key === 'F2') onEdit(s)
          if (e.key === 'Delete') void deleteItems(itemsFor(key))
        }}
      >
        <span className="name">
          {s.name}
          {s.type === 'ssh' && s.proxyJump?.enabled && s.proxyJump.chain.length > 0 && <span className="badge">jump</span>}
          {s.type === 'local' && s.hidden && <span className="badge">hidden</span>}
        </span>
        <span className="sub">{sub(s)}</span>
      </div>
    )
  }

  const folderRow = (n: FolderNode, depth: number): ReactNode => {
    const f = n.folder
    const key = folderKey(f.id)
    const closed = isCollapsed(f.id)
    return (
      <div key={f.id} {...dropProps(f.id)} className={dropTarget === f.id ? 'drop-zone active' : 'drop-zone'}>
        <div
          className={'folder-row' + (selected.includes(key) ? ' selected' : '')}
          style={{ paddingLeft: 6 + depth * 14 }}
          tabIndex={0}
          {...dragProps(key)}
          onClick={(e) => select(e, key)}
          onDoubleClick={() => toggle(f.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            if (!selected.includes(key)) setSelected([key])
            void folderMenu(f)
          }}
          onKeyDown={(e) => {
            if (e.key === 'F2') onFolderDialog(f)
            if (e.key === 'Delete') void deleteItems(itemsFor(key))
            if (e.key === 'ArrowRight' && closed) toggle(f.id)
            if (e.key === 'ArrowLeft' && !closed) toggle(f.id)
            if (e.key === 'Enter') toggle(f.id)
          }}
        >
          <span
            className="caret"
            onClick={(e) => {
              e.stopPropagation()
              toggle(f.id)
            }}
          >
            {closed ? '▸' : '▾'}
          </span>
          <span className="folder-icon">▤</span>
          <span className="name">{f.name}</span>
          <span className="count">{countServers(n)}</span>
        </div>
        {!closed && (
          <>
            {n.children.map((c) => folderRow(c, depth + 1))}
            {n.servers.map((s) => serverRow(s, depth + 1))}
          </>
        )}
      </div>
    )
  }

  const groupHeader = (key: string, title: string, extra?: ReactNode) => (
    <div className={'group-header' + (dropTarget === ROOT && key === ROOT ? ' drop-target' : '')} onClick={() => toggle(key)}>
      <span className="caret">{isCollapsed(key) ? '▸' : '▾'}</span>
      <span style={{ flex: 1 }}>{title}</span>
      {extra}
    </div>
  )

  return (
    <aside className="sidebar">
      <div className="search">
        <input
          placeholder="Search servers"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('')
            if (e.key === 'Enter' && visibleServers[0]) onOpen(visibleServers[0].id, e.shiftKey)
          }}
        />
      </div>
      <div
        className="tree"
        tabIndex={-1}
        {...dropProps(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected([])
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault()
            setSelected(order)
          }
          if (e.key === 'Escape') setSelected([])
        }}
      >
        {tree.folders.map((n) => folderRow(n, 0))}
        {(topSsh.length > 0 || tree.folders.length === 0) && (
          <div {...dropProps(null)}>
            {groupHeader(ROOT, tree.folders.length ? 'Ungrouped' : 'Servers')}
            {!isCollapsed(ROOT) && topSsh.map((s) => serverRow(s, 0))}
            {topSsh.length === 0 && !q && <div className="hint" style={{ padding: '2px 22px 6px' }}>No servers yet</div>}
          </div>
        )}
        {(topLocal.length > 0 || hiddenCount > 0) && (
          <div {...dropProps(null)}>
            {groupHeader(
              '__local',
              'Local',
              hiddenCount > 0 && (
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
              )
            )}
            {!isCollapsed('__local') && topLocal.map((s) => serverRow(s, 0))}
          </div>
        )}
        <div className="tree-spacer" {...dropProps(null)} />
      </div>
      <div className="footer">
        <button onClick={() => onEdit(null)} title="New server">
          + Server
        </button>
        <button
          onClick={() => {
            const sel = selected.length === 1 && selected[0].startsWith('f:') ? idOf(selected[0]) : undefined
            onFolderDialog(null, sel)
          }}
          title="New folder (inside the selected folder)"
        >
          + Folder
        </button>
        <button
          onClick={async () => {
            const r = await pt.config.importSshConfig()
            if (!r.ok) return notify(r.error, true)
            notify(`Imported ${r.added} server${r.added === 1 ? '' : 's'} from ~/.ssh/config${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}`)
          }}
          title="Import hosts from ~/.ssh/config"
        >
          Import
        </button>
      </div>
    </aside>
  )
}

function countServers(n: FolderNode): number {
  return n.servers.length + n.children.reduce((a, c) => a + countServers(c), 0)
}

/** Ids of folders that may contain the given items (not themselves or their descendants). */
export function validMoveTargets(doc: ServersDoc, items: ItemKey[]): Set<string> {
  const movingFolders = items.filter((k) => k.startsWith('f:')).map(idOf)
  return new Set(doc.folders.filter((f) => !movingFolders.some((m) => isDescendant(f.id, m, doc))).map((f) => f.id))
}
