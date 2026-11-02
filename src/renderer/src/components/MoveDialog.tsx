import { useMemo, useState } from 'react'
import type { ServersDoc } from '../../../shared/types'
import { folderTree, type FolderNode } from '../../../shared/folders'
import { fuzzyFilter } from '../../../shared/fuzzy'
import { validMoveTargets, type ItemKey } from './Sidebar'
import { Modal } from './Modal'

interface Props {
  doc: ServersDoc
  items: ItemKey[]
  onMove: (target: string | null) => void
  onClose: () => void
}

interface Row {
  id: string | null
  label: string
  depth: number
}

/** Pick a target folder (or the top level) for servers/folders. */
export function MoveDialog({ doc, items, onMove, onClose }: Props) {
  const [q, setQ] = useState('')
  const valid = useMemo(() => validMoveTargets(doc, items), [doc, items])
  const rows = useMemo(() => {
    const out: Row[] = [{ id: null, label: '(top level)', depth: 0 }]
    const walk = (n: FolderNode, depth: number) => {
      if (valid.has(n.folder.id)) out.push({ id: n.folder.id, label: n.folder.name, depth })
      n.children.forEach((c) => walk(c, depth + 1))
    }
    folderTree(doc, []).folders.forEach((n) => walk(n, 0))
    return q ? fuzzyFilter(q, out, (r) => r.label) : out
  }, [doc, valid, q])
  const [sel, setSel] = useState(0)
  const choose = (r: Row | undefined) => {
    if (!r) return
    onMove(r.id)
    onClose()
  }

  return (
    <Modal
      center
      title={`Move ${items.length === 1 ? 'item' : `${items.length} items`} to…`}
      onClose={onClose}
      onSubmit={() => choose(rows[sel])}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => choose(rows[sel])} disabled={!rows[sel]}>
            Move
          </button>
        </>
      }
    >
      <input
        autoFocus
        style={{ width: '100%', marginBottom: 6 }}
        placeholder="Filter folders"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setSel(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((s) => Math.min(rows.length - 1, s + 1))
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => Math.max(0, s - 1))
          }
        }}
      />
      <ul className="pick-list">
        {rows.map((r, i) => (
          <li
            key={r.id ?? 'root'}
            className={i === sel ? 'sel' : ''}
            style={{ paddingLeft: 8 + (q ? 0 : r.depth * 16) }}
            onMouseEnter={() => setSel(i)}
            onClick={() => choose(r)}
          >
            {r.id ? '▤ ' : ''}
            {r.label}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
