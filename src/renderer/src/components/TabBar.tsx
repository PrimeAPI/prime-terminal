import { useState, type ReactNode } from 'react'
import type { Settings, WindowTabsState } from '../../../shared/types'
import { pt } from '../lib/api'

interface Props {
  tabs: WindowTabsState
  settings: Settings
  onNewTab: () => void
  rightTools: ReactNode
}

const TAB_MIME = 'application/x-prime-tab'

export function TabBar({ tabs, settings, onNewTab, rightTools }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [dropAt, setDropAt] = useState<{ index: number; side: 'before' | 'after' } | null>(null)

  const startRename = (id: string, title: string) => {
    setRenaming(id)
    setRenameText(title)
  }
  const commitRename = () => {
    if (renaming && renameText.trim()) pt.tabs.rename(renaming, renameText.trim())
    setRenaming(null)
  }

  const onTabMenu = async (id: string, title: string) => {
    const kb = settings.keybindings
    const r = await pt.ui.contextMenu([
      { id: 'rename', label: 'Rename' },
      { id: 'duplicate', label: 'Duplicate' },
      { id: 'newwin', label: 'Move to new window' },
      { type: 'separator' },
      { id: 'close', label: 'Close', accelerator: kb.closeTab },
      { id: 'others', label: 'Close others', enabled: tabs.tabs.length > 1 }
    ])
    if (r === 'rename') startRename(id, title)
    else if (r === 'duplicate') pt.tabs.duplicate(id)
    else if (r === 'newwin') pt.tabs.moveToNewWindow(id)
    else if (r === 'close') pt.tabs.close(id)
    else if (r === 'others') pt.tabs.closeOthers(id)
  }

  const dropIndex = (e: React.DragEvent, i: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const after = e.clientX > rect.left + rect.width / 2
    return { index: after ? i + 1 : i, side: after ? ('after' as const) : ('before' as const) }
  }

  const isTabDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(TAB_MIME)

  return (
    <div className="tabbar">
      <div
        className="tabs"
        onDragOver={(e) => {
          if (!isTabDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(e) => {
          if (!isTabDrag(e)) return
          e.preventDefault()
          pt.tabs.drop(dropAt ? dropAt.index : tabs.tabs.length)
          setDropAt(null)
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropAt(null)
        }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) onNewTab()
        }}
      >
        {tabs.tabs.map((t, i) => {
          const active = t.sessionId === tabs.activeSessionId
          const dropCls = dropAt && dropAt.index === i && dropAt.side === 'before' ? ' drop-before' : dropAt && dropAt.index === i + 1 && dropAt.side === 'after' ? ' drop-after' : ''
          return (
            <div
              key={t.sessionId}
              className={'tab' + (active ? ' active' : '') + dropCls}
              draggable={renaming !== t.sessionId}
              title={`${t.title} (${t.state})`}
              onMouseDown={(e) => {
                if (e.button === 0) pt.tabs.activate(t.sessionId)
              }}
              onAuxClick={(e) => {
                if (e.button === 1) pt.tabs.close(t.sessionId)
              }}
              onDoubleClick={() => startRename(t.sessionId, t.title)}
              onContextMenu={(e) => {
                e.preventDefault()
                void onTabMenu(t.sessionId, t.title)
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, t.sessionId)
                e.dataTransfer.effectAllowed = 'move'
                pt.tabs.dragStart(t.sessionId)
              }}
              onDragEnd={() => {
                setDropAt(null)
                pt.tabs.dragEnd(t.sessionId)
              }}
              onDragOver={(e) => {
                if (!isTabDrag(e)) return
                e.preventDefault()
                setDropAt(dropIndex(e, i))
              }}
            >
              <span className={'state-dot ' + t.state} />
              {renaming === t.sessionId ? (
                <input
                  autoFocus
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={commitRename}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <span className="title">{t.title}</span>
              )}
              <button
                className="icon close"
                title="Close tab"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => pt.tabs.close(t.sessionId)}
              >
                ×
              </button>
            </div>
          )
        })}
        <button className="icon" title={`New tab (${settings.keybindings.newTab ?? ''})`} onClick={onNewTab} style={{ alignSelf: 'center', fontSize: 16 }}>
          +
        </button>
      </div>
      <div className="tools">{rightTools}</div>
    </div>
  )
}
