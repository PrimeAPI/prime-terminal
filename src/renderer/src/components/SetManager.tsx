import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigSnapshot, ForwardEntry, ForwardSet, ForwardSetsDoc, ForwardType, SshServer, TunnelSetStatus } from '../../../shared/types'
import { validateForwardSet, type Issue } from '../../../shared/forwardValidation'
import { exchangeSetSchema } from '../../../shared/schemas'
import {
  fromExchangeEntry,
  fromExchangeSet,
  parseClipboard,
  parseSetJson,
  toExchangeEntry,
  toExchangeSet
} from '../../../shared/setExchange'
import { newId } from '../../../shared/ids'
import { pt } from '../lib/api'
import { JsonEditor } from './JsonEditor'
import { Modal } from './Modal'

interface Props {
  config: ConfigSnapshot
  status: Record<string, TunnelSetStatus>
  onClose: () => void
  onEditAllJson: () => void
  notify: (msg: string, error?: boolean) => void
}

const blankEntry = (): ForwardEntry => ({ id: newId(), type: 'local', enabled: true, bindAddress: '127.0.0.1', bindPort: 0, targetHost: 'localhost', targetPort: 0 })

const isRunning = (s?: TunnelSetStatus) => !!s && s.state !== 'off' && s.state !== 'error'

export function SetManager({ config, status, onClose, onEditAllJson, notify }: Props) {
  const [draft, setDraft] = useState<ForwardSetsDoc>(() => structuredClone(config.sets))
  const [saved, setSaved] = useState<ForwardSetsDoc>(() => structuredClone(config.sets))
  const [selId, setSelId] = useState<string | null>(config.sets.sets[0]?.id ?? null)
  const [view, setView] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [rowSel, setRowSel] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [dragRow, setDragRow] = useState<string | null>(null)
  const [dropRow, setDropRow] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [restartHint, setRestartHint] = useState<string[]>([])
  const tableRef = useRef<HTMLDivElement>(null)

  // follow external changes to the file when we have no local edits
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  useEffect(() => {
    if (!dirty && JSON.stringify(config.sets) !== JSON.stringify(saved)) {
      setDraft(structuredClone(config.sets))
      setSaved(structuredClone(config.sets))
    }
  }, [config.sets])

  const servers = config.servers
  const sshServers = servers.servers.filter((s): s is SshServer => s.type === 'ssh')
  const set = draft.sets.find((s) => s.id === selId) ?? null
  const activeOthers = draft.sets.filter((s) => s.id !== selId && isRunning(status[s.id]))

  const validation = useMemo(
    () => (set ? validateForwardSet(set, { servers, activeSets: activeOthers }) : { errors: [], warnings: [] }),
    [set, servers, status]
  )
  const issueFor = (entryId: string | undefined, field: string): Issue | undefined =>
    validation.errors.find((e) => e.entryId === entryId && e.field === field) ??
    validation.warnings.find((e) => e.entryId === entryId && e.field === field)
  const cellCls = (entryId: string | undefined, field: string) => {
    if (validation.errors.some((e) => e.entryId === entryId && e.field === field)) return 'invalid'
    if (validation.warnings.some((e) => e.entryId === entryId && e.field === field)) return 'warning'
    return ''
  }

  const updateSet = (fn: (s: ForwardSet) => ForwardSet) => {
    if (!set) return
    setDraft((d) => ({ sets: d.sets.map((s) => (s.id === set.id ? fn(structuredClone(s)) : s)) }))
  }
  const updateEntry = (id: string, patch: Partial<ForwardEntry>) =>
    updateSet((s) => ({ ...s, forwards: s.forwards.map((f) => (f.id === id ? { ...f, ...patch } : f)) }))

  // keep JSON view in sync with the selected set
  useEffect(() => {
    if (view === 'json' && set) {
      setJsonText(JSON.stringify(toExchangeSet(set, servers), null, 2))
      setJsonError(null)
    }
  }, [view, selId])

  const switchView = (v: 'form' | 'json') => {
    if (v === view) return
    if (v === 'form' && jsonError) {
      notify('Fix the JSON errors before switching to the form view', true)
      return
    }
    if (v === 'json' && set) {
      setJsonText(JSON.stringify(toExchangeSet(set, servers), null, 2))
      setJsonError(null)
    }
    setView(v)
  }

  const onJsonChange = (text: string) => {
    setJsonText(text)
    if (!set) return
    const r = parseSetJson(text, set, servers)
    if (r.ok) {
      setJsonError(null)
      setDraft((d) => ({ sets: d.sets.map((s) => (s.id === set.id ? r.set : s)) }))
    } else setJsonError(r.error)
  }

  const selectSet = (id: string) => {
    if (view === 'json' && jsonError) {
      notify('Fix the JSON errors first', true)
      return
    }
    setSelId(id)
    setRowSel([])
  }

  // ---- set actions ----
  const newSet = () => {
    const s: ForwardSet = { id: newId(), name: 'New set', server: sshServers[0]?.id ?? '', forwards: [blankEntry()] }
    setDraft((d) => ({ sets: [...d.sets, s] }))
    setSelId(s.id)
  }
  const duplicateSet = () => {
    if (!set) return
    const copy: ForwardSet = { ...structuredClone(set), id: newId(), name: `${set.name} (copy)`, forwards: set.forwards.map((f) => ({ ...f, id: newId() })) }
    delete copy.autoStart
    setDraft((d) => {
      const i = d.sets.findIndex((s) => s.id === set.id)
      const sets = [...d.sets]
      sets.splice(i + 1, 0, copy)
      return { sets }
    })
    setSelId(copy.id)
  }
  const deleteSet = () => {
    if (!set) return
    if (!confirm(`Delete set "${set.name}"?`)) return
    if (isRunning(status[set.id])) void pt.tunnels.deactivate(set.id)
    const i = draft.sets.findIndex((s) => s.id === set.id)
    const rest = draft.sets.filter((s) => s.id !== set.id)
    setDraft({ sets: rest })
    setSelId(rest[Math.min(i, rest.length - 1)]?.id ?? null)
  }
  const copySet = () => {
    if (!set) return
    pt.ui.clipboardWrite(JSON.stringify(toExchangeSet(set, servers), null, 2))
    notify(`Copied set "${set.name}" as JSON`)
  }
  const addImportedSets = (text: string, source: string) => {
    const c = parseClipboard(text)
    if (!c) return notify(`${source} does not contain a forwarding set or entries`, true)
    if (c.kind === 'entries') {
      if (!set) return notify('Select a set to paste entries into', true)
      return pasteEntries(c.entries.map(fromExchangeEntry))
    }
    const imported = c.sets.map((x) => fromExchangeSet(x, servers))
    setDraft((d) => ({ sets: [...d.sets, ...imported] }))
    setSelId(imported[0].id)
    const unresolved = imported.filter((s) => s.unresolvedServer).map((s) => s.unresolvedServer)
    notify(
      `Added ${imported.length} set${imported.length > 1 ? 's' : ''}` +
        (unresolved.length ? ` – server not found: ${unresolved.join(', ')} (choose a server)` : ''),
      unresolved.length > 0
    )
  }
  const pasteSet = async () => addImportedSets(await pt.ui.clipboardRead(), 'Clipboard')
  const exportSets = async () => {
    const list = set ? [set] : draft.sets
    const text = JSON.stringify(list.length === 1 ? toExchangeSet(list[0], servers) : { sets: list.map((s) => toExchangeSet(s, servers)) }, null, 2)
    const name = (set ? set.name : 'forward-sets').replace(/[^\w.-]+/g, '_') + '.json'
    if (await pt.config.exportText(name, text + '\n')) notify('Exported')
  }
  const importSets = async () => {
    const text = await pt.config.importText()
    if (text !== null) addImportedSets(text, 'File')
  }

  // ---- entry actions ----
  const selectedEntries = () => (set ? set.forwards.filter((f) => rowSel.includes(f.id)) : [])
  const addEntry = () => {
    const e = blankEntry()
    updateSet((s) => ({ ...s, forwards: [...s.forwards, e] }))
    setRowSel([e.id])
    setTimeout(() => tableRef.current?.querySelector<HTMLInputElement>(`tr[data-id="${e.id}"] input[data-col="name"]`)?.focus(), 0)
  }
  const duplicateEntries = () => {
    const sel = selectedEntries()
    if (!sel.length) return
    const copies = sel.map((f) => ({ ...f, id: newId() }))
    updateSet((s) => {
      const last = Math.max(...sel.map((f) => s.forwards.findIndex((x) => x.id === f.id)))
      const forwards = [...s.forwards]
      forwards.splice(last + 1, 0, ...copies)
      return { ...s, forwards }
    })
    setRowSel(copies.map((c) => c.id))
  }
  const deleteEntries = () => {
    const ids = new Set(rowSel)
    if (!ids.size) return
    updateSet((s) => ({ ...s, forwards: s.forwards.filter((f) => !ids.has(f.id)) }))
    setRowSel([])
  }
  const copyEntries = () => {
    const sel = selectedEntries()
    if (!sel.length) return
    const x = sel.map(toExchangeEntry)
    pt.ui.clipboardWrite(JSON.stringify(x.length === 1 ? x[0] : x, null, 2))
    notify(`Copied ${x.length} entr${x.length === 1 ? 'y' : 'ies'}`)
  }
  const pasteEntries = (entries: ForwardEntry[]) => {
    updateSet((s) => {
      const forwards = [...s.forwards]
      const lastSel = Math.max(-1, ...rowSel.map((id) => forwards.findIndex((f) => f.id === id)))
      forwards.splice(lastSel >= 0 ? lastSel + 1 : forwards.length, 0, ...entries)
      return { ...s, forwards }
    })
    setRowSel(entries.map((e) => e.id))
  }
  const pasteFromClipboard = async () => {
    const c = parseClipboard(await pt.ui.clipboardRead())
    if (!c) return notify('Clipboard does not contain forwarding entries', true)
    if (c.kind === 'entries') pasteEntries(c.entries.map(fromExchangeEntry))
    else pasteEntries(c.sets.flatMap((s) => s.forwards.map(fromExchangeEntry)))
  }
  const moveEntries = (delta: number) => {
    if (!set || !rowSel.length) return
    updateSet((s) => {
      const f = [...s.forwards]
      const idx = f.map((x, i) => (rowSel.includes(x.id) ? i : -1)).filter((i) => i >= 0)
      if (delta < 0 && idx[0] === 0) return s
      if (delta > 0 && idx[idx.length - 1] === f.length - 1) return s
      const order = delta < 0 ? idx : [...idx].reverse()
      for (const i of order) [f[i], f[i + delta]] = [f[i + delta], f[i]]
      return { ...s, forwards: f }
    })
  }
  const moveRowTo = (id: string, index: number) =>
    updateSet((s) => {
      const f = [...s.forwards]
      const from = f.findIndex((x) => x.id === id)
      if (from < 0) return s
      const [row] = f.splice(from, 1)
      f.splice(from < index ? index - 1 : index, 0, row)
      return { ...s, forwards: f }
    })

  const clickRow = (e: React.MouseEvent, id: string) => {
    if (!set) return
    if (e.shiftKey && anchor) {
      const ids = set.forwards.map((f) => f.id)
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y)
      setRowSel(ids.slice(a, b + 1))
    } else if (e.ctrlKey || e.metaKey) {
      setRowSel(rowSel.includes(id) ? rowSel.filter((x) => x !== id) : [...rowSel, id])
      setAnchor(id)
    } else {
      setRowSel([id])
      setAnchor(id)
    }
    tableRef.current?.focus()
  }

  const onTableKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT') {
      // Enter moves to the next cell like Tab
      if (e.key === 'Enter') {
        e.preventDefault()
        const inputs = Array.from(tableRef.current!.querySelectorAll<HTMLElement>('input:not([disabled]), select:not([disabled])'))
        const i = inputs.indexOf(t)
        inputs[e.shiftKey ? i - 1 : i + 1]?.focus()
      }
      return
    }
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      copyEntries()
    } else if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      void pasteFromClipboard()
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      duplicateEntries()
    } else if (mod && e.key.toLowerCase() === 'a' && set) {
      e.preventDefault()
      setRowSel(set.forwards.map((f) => f.id))
    } else if (e.key === 'Delete') {
      e.preventDefault()
      deleteEntries()
    } else if (e.altKey && e.key === 'ArrowUp') moveEntries(-1)
    else if (e.altKey && e.key === 'ArrowDown') moveEntries(1)
  }

  // ---- save ----
  const allErrors = draft.sets.map((s) => ({ s, errs: validateForwardSet(s, { servers }).errors })).filter((x) => x.errs.length)
  const save = async () => {
    if (view === 'json' && jsonError) return setSaveError('Fix the JSON errors first')
    const r = await pt.config.saveSets(draft)
    if (!r.ok) return setSaveError(r.error)
    setSaveError(null)
    const changedRunning = draft.sets
      .filter((s) => isRunning(status[s.id]))
      .filter((s) => JSON.stringify(s) !== JSON.stringify(saved.sets.find((o) => o.id === s.id)))
      .map((s) => s.id)
    setRestartHint((h) => [...new Set([...h, ...changedRunning])])
    setSaved(structuredClone(draft))
  }
  const close = () => {
    if (dirty && !confirm('Discard unsaved changes to forwarding sets?')) return
    onClose()
  }

  const proxyMode = !set ? 'default' : set.proxyJump === undefined ? 'default' : set.proxyJump.length === 0 ? 'direct' : 'custom'
  const showRestart = set && restartHint.includes(set.id) && isRunning(status[set.id])

  return (
    <Modal
      size="wide"
      title={
        <>
          Port forwarding sets
          <span className="spacer" style={{ flex: 1 }} />
          <button className="icon" style={{ fontWeight: 400, fontSize: 12 }} onClick={onEditAllJson} title="Edit forward-sets.json directly">
            Edit all sets as JSON…
          </button>
        </>
      }
      onClose={close}
      footer={
        <>
          {saveError ? (
            <span className="error-text">{saveError}</span>
          ) : allErrors.length > 0 ? (
            <span className="warn-text">
              {allErrors.length} set{allErrors.length > 1 ? 's have' : ' has'} problems ({allErrors.map((x) => x.s.name).join(', ')})
            </span>
          ) : (
            <span className="hint">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          )}
          <span className="spacer" />
          <button
            disabled={!dirty}
            onClick={() => {
              setDraft(structuredClone(saved))
              setJsonError(null)
              if (view === 'json') {
                const s = saved.sets.find((x) => x.id === selId)
                if (s) setJsonText(JSON.stringify(toExchangeSet(s, servers), null, 2))
              }
            }}
          >
            Revert
          </button>
          <button onClick={close}>Close</button>
          <button className="primary" disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="setmgr">
        <div className="setlist">
          <ul>
            {draft.sets.map((s) => (
              <li key={s.id} className={s.id === selId ? 'sel' : ''} onClick={() => selectSet(s.id)}>
                <span className={'state-dot ' + (status[s.id]?.state ?? 'off')} style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0 }} />
                <span className="nm">{s.name || '(unnamed)'}</span>
                {s.autoStart && <span className="badge">auto</span>}
              </li>
            ))}
            {draft.sets.length === 0 && <li className="hint">No sets yet</li>}
          </ul>
          <div className="toolbar">
            <button onClick={newSet}>New</button>
            <button onClick={duplicateSet} disabled={!set}>
              Duplicate
            </button>
            <button onClick={deleteSet} disabled={!set} className="danger">
              Delete
            </button>
            <button onClick={copySet} disabled={!set} title="Copy set as JSON">
              Copy
            </button>
            <button onClick={() => void pasteSet()} title="Paste set(s) or entries from clipboard">
              Paste
            </button>
            <button onClick={() => void importSets()}>Import…</button>
            <button onClick={() => void exportSets()} disabled={draft.sets.length === 0}>
              Export…
            </button>
          </div>
        </div>

        {set ? (
          <div className="editor">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="segmented">
                <button className={view === 'form' ? 'on' : ''} onClick={() => switchView('form')}>
                  Form
                </button>
                <button className={view === 'json' ? 'on' : ''} onClick={() => switchView('json')}>
                  JSON
                </button>
              </div>
              <span style={{ flex: 1 }} />
              {showRestart && (
                <>
                  <span className="warn-text">Restart set to apply changes</span>
                  <button
                    onClick={async () => {
                      await pt.tunnels.activate(set.id)
                      setRestartHint((h) => h.filter((x) => x !== set.id))
                    }}
                  >
                    Restart
                  </button>
                </>
              )}
            </div>

            {view === 'form' ? (
              <>
                <div className="set-header">
                  <label>Name</label>
                  <input className={cellCls(undefined, 'name')} value={set.name} onChange={(e) => updateSet((s) => ({ ...s, name: e.target.value }))} />
                  <label>Server</label>
                  <select
                    className={cellCls(undefined, 'server')}
                    value={set.server}
                    title={issueFor(undefined, 'server')?.message}
                    onChange={(e) =>
                      updateSet((s) => {
                        const n = { ...s, server: e.target.value }
                        delete n.unresolvedServer
                        return n
                      })
                    }
                  >
                    {!set.server && <option value="">{set.unresolvedServer ? `(not found: ${set.unresolvedServer})` : '(choose server)'}</option>}
                    {sshServers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.username}@{s.host})
                      </option>
                    ))}
                  </select>
                  <label>Proxy jump</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                      value={proxyMode}
                      className={cellCls(undefined, 'proxyJump')}
                      onChange={(e) =>
                        updateSet((s) => {
                          const n = { ...s }
                          if (e.target.value === 'default') delete n.proxyJump
                          else if (e.target.value === 'direct') n.proxyJump = []
                          else {
                            const srv = sshServers.find((x) => x.id === s.server)
                            const def = srv?.proxyJump?.chain ?? []
                            n.proxyJump = def.length ? [...def] : sshServers.filter((x) => x.id !== s.server).slice(0, 1).map((x) => x.id)
                          }
                          return n
                        })
                      }
                    >
                      <option value="default">Use server setting</option>
                      <option value="direct">Direct (no jump)</option>
                      <option value="custom">Custom chain</option>
                    </select>
                    {proxyMode === 'custom' &&
                      set.proxyJump!.map((hid, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          {i > 0 && <span className="hint">→</span>}
                          <select
                            value={hid}
                            onChange={(e) => updateSet((s) => ({ ...s, proxyJump: s.proxyJump!.map((x, j) => (j === i ? e.target.value : x)) }))}
                          >
                            {!sshServers.some((x) => x.id === hid) && <option value={hid}>(missing: {hid})</option>}
                            {sshServers
                              .filter((x) => x.id !== set.server)
                              .map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name}
                                </option>
                              ))}
                          </select>
                          <button className="icon" title="Remove hop" onClick={() => updateSet((s) => ({ ...s, proxyJump: s.proxyJump!.filter((_, j) => j !== i) }))}>
                            ✕
                          </button>
                        </span>
                      ))}
                    {proxyMode === 'custom' && (
                      <button
                        className="icon"
                        title="Add hop"
                        onClick={() => {
                          const cand = sshServers.find((x) => x.id !== set.server && !set.proxyJump!.includes(x.id))
                          if (cand) updateSet((s) => ({ ...s, proxyJump: [...s.proxyJump!, cand.id] }))
                        }}
                      >
                        + hop
                      </button>
                    )}
                    {proxyMode === 'default' && (
                      <span className="hint">
                        {(() => {
                          const srv = sshServers.find((x) => x.id === set.server)
                          if (!srv?.proxyJump?.enabled || !srv.proxyJump.chain.length) return 'direct'
                          return 'via ' + srv.proxyJump.chain.map((id) => servers.servers.find((x) => x.id === id)?.name ?? '?').join(' → ')
                        })()}
                      </span>
                    )}
                  </div>
                  <label>Auto-start</label>
                  <label style={{ color: 'inherit' }}>
                    <input
                      type="checkbox"
                      checked={!!set.autoStart}
                      onChange={(e) =>
                        updateSet((s) => {
                          const n = { ...s }
                          if (e.target.checked) n.autoStart = true
                          else delete n.autoStart
                          return n
                        })
                      }
                    />{' '}
                    Activate when the app starts
                  </label>
                </div>

                <div className="entries-toolbar">
                  <button onClick={addEntry}>+ Add</button>
                  <button onClick={duplicateEntries} disabled={!rowSel.length} title="Ctrl+D">
                    Duplicate
                  </button>
                  <button onClick={deleteEntries} disabled={!rowSel.length} title="Del">
                    Delete
                  </button>
                  <button onClick={copyEntries} disabled={!rowSel.length} title="Ctrl+C">
                    Copy
                  </button>
                  <button onClick={() => void pasteFromClipboard()} title="Ctrl+V">
                    Paste
                  </button>
                  <button onClick={() => moveEntries(-1)} disabled={!rowSel.length} title="Alt+↑">
                    ↑
                  </button>
                  <button onClick={() => moveEntries(1)} disabled={!rowSel.length} title="Alt+↓">
                    ↓
                  </button>
                  <span className="hint" style={{ marginLeft: 8 }}>
                    Click the # column to select rows (Shift/Ctrl for multiple), drag it to reorder.
                  </span>
                </div>

                <div className="table-wrap" ref={tableRef} tabIndex={0} onKeyDown={onTableKey}>
                  <table className="fwd">
                    <colgroup>
                      <col />
                      <col className="c-on" />
                      <col />
                      <col className="c-type" />
                      <col className="c-addr" />
                      <col className="c-port" />
                      <col />
                      <col className="c-port" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th title="Enabled">On</th>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Bind address</th>
                        <th>Bind port</th>
                        <th>Target host</th>
                        <th>Target port</th>
                      </tr>
                    </thead>
                    <tbody>
                      {set.forwards.map((f, i) => {
                        const dyn = f.type === 'dynamic'
                        return (
                          <tr
                            key={f.id}
                            data-id={f.id}
                            className={(rowSel.includes(f.id) ? 'sel ' : '') + (f.enabled ? '' : 'disabled ') + (dropRow === i ? 'drop-before' : '')}
                            onDragOver={(e) => {
                              if (!dragRow) return
                              e.preventDefault()
                              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                              setDropRow(e.clientY > r.top + r.height / 2 ? i + 1 : i)
                            }}
                            onDrop={(e) => {
                              e.preventDefault()
                              if (dragRow && dropRow !== null) moveRowTo(dragRow, dropRow)
                              setDragRow(null)
                              setDropRow(null)
                            }}
                          >
                            <td
                              className="handle"
                              draggable
                              onClick={(e) => clickRow(e, f.id)}
                              onDragStart={(e) => {
                                e.dataTransfer.setData('text/plain', f.id)
                                setDragRow(f.id)
                              }}
                              onDragEnd={() => {
                                setDragRow(null)
                                setDropRow(null)
                              }}
                            >
                              {i + 1}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <input type="checkbox" checked={f.enabled} onChange={(e) => updateEntry(f.id, { enabled: e.target.checked })} />
                            </td>
                            <td>
                              <input data-col="name" value={f.name ?? ''} placeholder="(optional)" onChange={(e) => updateEntry(f.id, { name: e.target.value || undefined })} />
                            </td>
                            <td>
                              <select
                                className={cellCls(f.id, 'type')}
                                value={f.type}
                                onChange={(e) => {
                                  const type = e.target.value as ForwardType
                                  const patch: Partial<ForwardEntry> = { type }
                                  if (type === 'dynamic') {
                                    patch.targetHost = undefined
                                    patch.targetPort = undefined
                                  } else if (f.targetHost === undefined) patch.targetHost = 'localhost'
                                  updateEntry(f.id, patch)
                                }}
                              >
                                <option value="local">Local (-L)</option>
                                <option value="remote">Remote (-R)</option>
                                <option value="dynamic">SOCKS (-D)</option>
                              </select>
                            </td>
                            <td>
                              <input value={f.bindAddress ?? ''} placeholder="127.0.0.1" onChange={(e) => updateEntry(f.id, { bindAddress: e.target.value || undefined })} />
                            </td>
                            <td>
                              <PortInput value={f.bindPort} className={cellCls(f.id, 'bindPort')} title={issueFor(f.id, 'bindPort')?.message} onChange={(p) => updateEntry(f.id, { bindPort: p ?? 0 })} />
                            </td>
                            <td>
                              <input
                                disabled={dyn}
                                className={cellCls(f.id, 'targetHost')}
                                title={issueFor(f.id, 'targetHost')?.message}
                                value={dyn ? '' : (f.targetHost ?? '')}
                                placeholder={dyn ? '(SOCKS proxy)' : 'host'}
                                onChange={(e) => updateEntry(f.id, { targetHost: e.target.value })}
                              />
                            </td>
                            <td>
                              <PortInput
                                disabled={dyn}
                                value={dyn ? undefined : f.targetPort}
                                className={cellCls(f.id, 'targetPort')}
                                title={issueFor(f.id, 'targetPort')?.message}
                                onChange={(p) => updateEntry(f.id, { targetPort: p })}
                              />
                            </td>
                          </tr>
                        )
                      })}
                      {set.forwards.length === 0 && (
                        <tr>
                          <td colSpan={8} className="hint" style={{ padding: 12 }}>
                            No forwards yet – click “+ Add” or paste entries.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {(validation.errors.length > 0 || validation.warnings.length > 0) && (
                  <div className="issues">
                    {validation.errors.map((e, i) => (
                      <div key={'e' + i} className="error-text">
                        {e.entryId ? `#${set.forwards.findIndex((f) => f.id === e.entryId) + 1}: ` : ''}
                        {e.message}
                      </div>
                    ))}
                    {validation.warnings.map((e, i) => (
                      <div key={'w' + i} className="warn-text">
                        {e.entryId ? `#${set.forwards.findIndex((f) => f.id === e.entryId) + 1}: ` : ''}
                        {e.message}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <JsonEditor value={jsonText} onChange={onJsonChange} schema={exchangeSetSchema} onSave={() => void save()} />
                {jsonError ? (
                  <div className="error-text">{jsonError}</div>
                ) : (
                  <div className="hint">
                    Servers are referenced by name. This JSON can be copied to other sets or installations. Ctrl+Space for completion.
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="editor">
            <div className="hint" style={{ margin: 'auto' }}>
              {sshServers.length === 0 ? 'Add an SSH server first, then create a set.' : 'Create a set with “New” or paste one from the clipboard.'}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function PortInput({
  value,
  onChange,
  className,
  title,
  disabled
}: {
  value: number | undefined
  onChange: (v: number | undefined) => void
  className?: string
  title?: string
  disabled?: boolean
}) {
  const [text, setText] = useState(value ? String(value) : '')
  useEffect(() => {
    setText(value ? String(value) : '')
  }, [value])
  return (
    <input
      inputMode="numeric"
      disabled={disabled}
      className={className}
      title={title}
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d]/g, '')
        setText(t)
        onChange(t ? Number(t) : undefined)
      }}
    />
  )
}
