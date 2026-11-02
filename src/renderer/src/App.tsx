import { useCallback, useEffect, useRef, useState } from 'react'
import { isTunnelRunning, type ConfigFileKind, type Folder, type KeybindingAction, type OpenTarget, type Server } from '../../shared/types'
import { matchAction } from '../../shared/keybindings'
import { newId } from '../../shared/ids'
import { pt } from './lib/api'
import { useConfig, useLocalStorage, useTabs, useTunnels } from './lib/hooks'
import { scheme } from './lib/themes'
import { TabBar } from './components/TabBar'
import { TerminalView, type TerminalHandle } from './components/TerminalView'
import { Sidebar, moveItems, type ItemKey } from './components/Sidebar'
import { MoveDialog } from './components/MoveDialog'
import { BackupDialog } from './components/BackupDialog'
import { folderPath } from '../../shared/folders'
import { QuickConnect } from './components/QuickConnect'
import { ServerDialog } from './components/ServerDialog'
import { TunnelPopup, overallState } from './components/TunnelPopup'
import { SetManager } from './components/SetManager'
import { ConfigEditorDialog } from './components/ConfigEditorDialog'
import { PromptHost } from './components/PromptHost'
import { TextInputDialog } from './components/TextInputDialog'

type Overlay =
  | { kind: 'quick' }
  | { kind: 'server'; server: Server | null; folderId?: string }
  | { kind: 'folder'; folder: Folder | null; parentId?: string }
  | { kind: 'move'; items: ItemKey[] }
  | { kind: 'backup'; mode: 'export' | 'import' }
  | { kind: 'sets' }
  | { kind: 'file'; file: ConfigFileKind }
  | null

interface Toast {
  id: string
  msg: string
  error?: boolean
}

export function App() {
  const config = useConfig()
  const tabs = useTabs()
  const tunnels = useTunnels()
  const [sidebar, setSidebar] = useLocalStorage('sidebar.visible', true)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [setsUnder, setSetsUnder] = useState(false)
  const [tunnelOpen, setTunnelOpen] = useState(false)
  const [zoom, setZoom] = useState(0)
  const [toasts, setToasts] = useState<Toast[]>([])
  const terms = useRef(new Map<string, TerminalHandle>())

  const notify = useCallback((msg: string, error?: boolean) => {
    const id = newId()
    setToasts((t) => [...t, { id, msg, error }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 8000 : 4000)
  }, [])

  const activeId = tabs?.activeSessionId ?? null
  const activeTerm = () => (activeId ? terms.current.get(activeId) : undefined)

  const open = useCallback(
    async (target: OpenTarget, newWindow = false) => {
      const r = await pt.sessions.open(target, { newWindow })
      if (!r.ok) notify(r.error, true)
    },
    [notify]
  )

  // window title
  useEffect(() => {
    const t = tabs?.tabs.find((x) => x.sessionId === activeId)
    pt.windows.setTitle(t ? `${t.title} — Prime Terminal` : 'Prime Terminal')
  }, [tabs, activeId])

  // global keybindings (capture phase, so the terminal never sees them)
  const actionRef = useRef<(a: KeybindingAction, e: KeyboardEvent) => boolean>(() => false)
  actionRef.current = (a, e) => {
    const target = e.target as HTMLElement
    const editable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || !!target.closest('.cm-editor')
    const modal = overlay !== null || !!document.querySelector('.backdrop')
    if (modal && a !== 'newWindow') return false
    if (editable && (a === 'copy' || a === 'paste' || a === 'find')) return false
    switch (a) {
      case 'copy':
        activeTerm()?.copy()
        break
      case 'paste':
        activeTerm()?.paste()
        break
      case 'find':
        activeTerm()?.find()
        break
      case 'newTab':
      case 'quickConnect':
        setOverlay({ kind: 'quick' })
        break
      case 'closeTab':
        if (activeId) pt.tabs.close(activeId)
        break
      case 'newWindow':
        pt.windows.newWindow()
        break
      case 'prevTab':
        pt.tabs.cycle(-1)
        break
      case 'nextTab':
        pt.tabs.cycle(1)
        break
      case 'moveTabLeft':
        if (activeId) pt.tabs.moveBy(activeId, -1)
        break
      case 'moveTabRight':
        if (activeId) pt.tabs.moveBy(activeId, 1)
        break
      case 'zoomIn':
        setZoom((z) => Math.min(z + 1, 40))
        break
      case 'zoomOut':
        setZoom((z) => Math.max(z - 1, -8))
        break
      case 'zoomReset':
        setZoom(0)
        break
      case 'toggleSidebar':
        setSidebar(!sidebar)
        break
      default:
        if (a.startsWith('goToTab')) pt.tabs.activateIndex(Number(a.slice(7)) - 1)
        else return false
    }
    return true
  }
  useEffect(() => {
    if (!config) return
    const bindings = config.settings.keybindings
    const onKey = (e: KeyboardEvent) => {
      const action = matchAction(e, bindings)
      if (!action) return
      if (actionRef.current(action, e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [config])

  if (!config || !tabs) return null

  const ui = scheme(config.settings.terminal.colorScheme).ui
  document.documentElement.dataset.ui = ui
  const errors = Object.entries(config.errors) as [ConfigFileKind, string][]
  const tunnelState = overallState(tunnels)
  const runningCount = Object.values(tunnels).filter(isTunnelRunning).length

  const mainMenu = async () => {
    const kb = config.settings.keybindings
    const r = await pt.ui.contextMenu([
      { id: 'quick', label: 'New tab…', accelerator: kb.newTab },
      { id: 'window', label: 'New window', accelerator: kb.newWindow },
      { id: 'sidebar', label: 'Show server list', type: 'checkbox', checked: sidebar, accelerator: kb.toggleSidebar },
      { type: 'separator' },
      { id: 'sets', label: 'Port forwarding sets…' },
      { id: 'setsjson', label: 'Edit forward-sets.json…' },
      { type: 'separator' },
      { id: 'newserver', label: 'New server…' },
      { id: 'import', label: 'Import from ~/.ssh/config' },
      { id: 'serversjson', label: 'Edit servers.json…' },
      { type: 'separator' },
      { id: 'settings', label: 'Settings (settings.json)…' },
      { type: 'separator' },
      { id: 'export', label: 'Export configuration…' },
      { id: 'importcfg', label: 'Import configuration…' }
    ])
    if (r === 'quick') setOverlay({ kind: 'quick' })
    else if (r === 'window') pt.windows.newWindow()
    else if (r === 'sidebar') setSidebar(!sidebar)
    else if (r === 'sets') setOverlay({ kind: 'sets' })
    else if (r === 'setsjson') setOverlay({ kind: 'file', file: 'sets' })
    else if (r === 'newserver') setOverlay({ kind: 'server', server: null })
    else if (r === 'serversjson') setOverlay({ kind: 'file', file: 'servers' })
    else if (r === 'settings') setOverlay({ kind: 'file', file: 'settings' })
    else if (r === 'export') setOverlay({ kind: 'backup', mode: 'export' })
    else if (r === 'importcfg') setOverlay({ kind: 'backup', mode: 'import' })
    else if (r === 'import') {
      const res = await pt.config.importSshConfig()
      if (!res.ok) notify(res.error, true)
      else notify(`Imported ${res.added} server${res.added === 1 ? '' : 's'} from ~/.ssh/config`)
    }
  }

  const saveFolder = async (folder: Folder | null, name: string, parentId?: string) => {
    const doc = config.servers
    const next = folder
      ? { ...doc, folders: doc.folders.map((f) => (f.id === folder.id ? { ...f, name } : f)) }
      : { ...doc, folders: [...doc.folders, { id: newId(), name, ...(parentId ? { parentId } : {}) }] }
    const r = await pt.config.saveServers(next)
    if (!r.ok) notify(r.error, true)
  }

  return (
    <div className="app">
      {sidebar && (
        <Sidebar
          doc={config.servers}
          onOpen={(id, nw) => void open({ serverId: id }, nw)}
          onEdit={(server, folderId) => setOverlay({ kind: 'server', server, folderId })}
          onFolderDialog={(folder, parentId) => setOverlay({ kind: 'folder', folder, parentId })}
          onMove={(items) => setOverlay({ kind: 'move', items })}
          notify={notify}
        />
      )}
      <div className="main">
        {errors.map(([kind, msg]) => (
          <div className="banner" key={kind}>
            <span className="msg">
              {kind === 'sets' ? 'forward-sets.json' : `${kind}.json`} is invalid – using the last valid version: {msg}
            </span>
            <button onClick={() => setOverlay({ kind: 'file', file: kind })}>Open</button>
          </div>
        ))}
        <TabBar
          tabs={tabs}
          settings={config.settings}
          onNewTab={() => setOverlay({ kind: 'quick' })}
          rightTools={
            <>
              <button
                className="icon"
                data-tunnel-button
                title={`Port forwarding${runningCount ? ` (${runningCount} active)` : ''}`}
                onClick={() => setTunnelOpen((v) => !v)}
              >
                ⇄{tunnelState !== 'off' && <span className={'tunnel-indicator state-dot ' + tunnelState} />}
              </button>
              <button className="icon" title="Menu" onClick={() => void mainMenu()}>
                ≡
              </button>
              {tunnelOpen && (
                <TunnelPopup
                  config={config}
                  status={tunnels}
                  onManage={() => setOverlay({ kind: 'sets' })}
                  onClose={() => setTunnelOpen(false)}
                  notify={notify}
                />
              )}
            </>
          }
        />
        <div className="terminals">
          {tabs.tabs.map((t) => (
            <TerminalView
              key={t.sessionId}
              ref={(h) => {
                if (h) terms.current.set(t.sessionId, h)
                else terms.current.delete(t.sessionId)
              }}
              sessionId={t.sessionId}
              active={t.sessionId === activeId && overlay === null}
              settings={config.settings}
              zoom={zoom}
            />
          ))}
          {tabs.tabs.length === 0 && (
            <div className="empty-state">
              <div>No open sessions</div>
              <div>
                <button className="primary" onClick={() => setOverlay({ kind: 'quick' })}>
                  Connect…
                </button>
              </div>
              <div className="hint">
                <kbd>{config.settings.keybindings.quickConnect}</kbd> quick connect · double-click a server in the list
              </div>
            </div>
          )}
        </div>
      </div>

      {overlay?.kind === 'quick' && <QuickConnect servers={config.servers} onOpen={(t, nw) => void open(t, nw)} onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'server' && (
        <ServerDialog
          doc={config.servers}
          server={overlay.server}
          defaultFolderId={overlay.folderId}
          onClose={() => setOverlay(null)}
          onSaved={(s) => notify(`Saved ${s.name}`)}
        />
      )}
      {overlay?.kind === 'folder' && (
        <TextInputDialog
          title={overlay.folder ? 'Rename folder' : overlay.parentId ? `New folder in ${folderPath(overlay.parentId, config.servers)}` : 'New folder'}
          label="Folder name"
          initial={overlay.folder?.name}
          onSubmit={(name) => void saveFolder(overlay.folder, name, overlay.parentId)}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === 'move' && (
        <MoveDialog
          doc={config.servers}
          items={overlay.items}
          onClose={() => setOverlay(null)}
          onMove={async (target) => {
            const r = moveItems(config.servers, overlay.items, target)
            if (r.skipped) notify('A folder cannot be moved into itself', true)
            const res = await pt.config.saveServers(r.doc)
            if (!res.ok) notify(res.error, true)
          }}
        />
      )}
      {overlay?.kind === 'backup' && <BackupDialog mode={overlay.mode} onClose={() => setOverlay(null)} notify={notify} />}
      {(overlay?.kind === 'sets' || setsUnder) && (
        <div style={{ display: overlay?.kind === 'sets' ? 'contents' : 'none' }}>
          <SetManager
            config={config}
            status={tunnels}
            notify={notify}
            onClose={() => {
              setSetsUnder(false)
              setOverlay(null)
            }}
            onEditAllJson={() => {
              setSetsUnder(true)
              setOverlay({ kind: 'file', file: 'sets' })
            }}
          />
        </div>
      )}
      {overlay?.kind === 'file' && (
        <ConfigEditorDialog
          kind={overlay.file}
          path={config.paths[overlay.file]}
          onClose={() => setOverlay(setsUnder && overlay.file === 'sets' ? { kind: 'sets' } : null)}
        />
      )}
      <PromptHost />
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={'toast' + (t.error ? ' error' : '')}>
              {t.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
