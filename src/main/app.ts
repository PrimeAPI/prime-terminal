// Main-process controller: owns config, sessions, tunnels, windows and the tab model.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell, type WebContents } from 'electron'
import type {
  ConfigFileKind,
  ConfigSnapshot,
  ForwardSetsDoc,
  MenuItemSpec,
  OpenTarget,
  ServersDoc,
  SshServer,
  TabInfo
} from '../shared/types'
import { resolveServerHops, resolveSetHops } from '../shared/proxy'
import { newId } from '../shared/ids'
import { createConfigStores, type ConfigStores } from './config/configStores'
import { applyBackup, BACKUP_EXTENSION, createBackup, inspectBackup, readBackup } from './config/backup'
import { PromptService } from './prompts'
import { LocalPtyBackend, SshShellBackend } from './sessions/backends'
import { SessionManager } from './sessions/sessionManager'
import { detectShellsOnThisMachine, mergeDetectedShells } from './shells/detect'
import { detectAgentPaths } from './ssh/agent'
import { connectChain, type ConnectDeps, type Prompter } from './ssh/connect'
import { KnownHosts } from './ssh/knownHosts'
import { importSshConfig } from './ssh/sshConfigImport'
import { TunnelManager } from './tunnels/tunnelManager'
import { TabModel } from './windows/tabModel'
import { DesktopIntegration, type IntegrationOptions } from './desktop/integration'
import { resolveLaunchTarget, type LaunchArgs } from '../shared/launch'

interface WindowState {
  bounds?: { x: number; y: number; width: number; height: number }
  maximized?: boolean
}

type Result = { ok: true } | { ok: false; error: string }

/** Where a torn-off window is placed relative to the cursor (cursor lands on its tab bar). */
const TEAR_OFF_OFFSET = { x: 120, y: 16 }
/** Height of the area at the top of a window's content that counts as "tab bar" for drops. */
const TAB_BAR_ZONE = 64
const errorResult = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : String(e) })

export class PrimeApp {
  readonly stores: ConfigStores
  readonly sessions = new SessionManager()
  readonly tabs = new TabModel()
  readonly prompts = new PromptService()
  readonly tunnels: TunnelManager
  private windows = new Map<number, BrowserWindow>()
  readonly desktop: DesktopIntegration
  /** quick-connect requests from the command line, picked up by the window's renderer */
  private pendingQuick = new Map<number, { query: string; message: string }>()
  /** sessions each renderer currently shows (data is only sent for these) */
  private attached = new Map<number, Set<string>>()
  private pendingData = new Map<string, string>()
  private flushScheduled = false
  private dragging: { sessionId: string; fromWin: number; dropped: boolean } | null = null
  private adhocServers = new Map<string, SshServer>()
  private quitting = false
  private pendingBackups = new Map<string, Uint8Array>()
  private started = new Set<string>()
  private knownHosts = new KnownHosts(join(homedir(), '.ssh', 'known_hosts'))
  private agentPaths = detectAgentPaths()

  constructor(
    private readonly configDir: string,
    private readonly preloadPath: string,
    private readonly loadRenderer: (win: BrowserWindow) => void
  ) {
    this.stores = createConfigStores(configDir)
    this.desktop = new DesktopIntegration(join(configDir, 'desktop-integration.json'), () => this.stores.servers.value)
    this.tunnels = new TunnelManager({
      getSet: (id) => this.stores.sets.value.sets.find((s) => s.id === id),
      resolveHops: (set) => resolveSetHops(set, this.stores.servers.value),
      connect: (hops, { interactive }) =>
        connectChain(hops, this.connectDeps(interactive ? this.prompts.prompter(() => this.promptTarget()) : PromptService.silent)),
      backoff: () => {
        const t = this.stores.settings.value.tunnels
        return { min: t.reconnectBackoffMin, max: Math.max(t.reconnectBackoffMin, t.reconnectBackoffMax) }
      }
    })
  }

  // ---------- lifecycle ----------

  start(): void {
    this.stores.loadAll()
    const merged = mergeDetectedShells(this.stores.servers.value, detectShellsOnThisMachine())
    if (merged.changed && !this.stores.servers.error) this.stores.servers.save(merged.doc)
    this.stores.watchAll()
    for (const s of [this.stores.servers, this.stores.sets, this.stores.settings]) {
      s.on('change', () => this.broadcastConfig())
    }

    this.sessions.on('data', (id: string, data: string) => this.queueData(id, data))
    this.sessions.on('state', (id: string, state: TabInfo['state']) => this.tabs.setTabState(id, state))
    this.tabs.on('change', (winIds: number[]) => {
      for (const w of winIds) this.sendTo(w, 'tabs:state', this.tabs.state(w))
    })
    this.tunnels.on('change', (s) => this.broadcast('tunnels:status', s))

    this.stores.servers.on('change', () => this.desktop.scheduleSync())
    // refresh launchers (e.g. the AppImage was moved) and the Windows jump list
    this.desktop.scheduleSync(3000)

    this.registerIpc()
    this.createWindow()

    for (const set of this.stores.sets.value.sets) {
      if (set.autoStart) void this.tunnels.activate(set.id).catch(() => {})
    }
  }

  async shutdown(): Promise<void> {
    this.quitting = true
    this.sessions.closeAll()
    await this.tunnels.stopAll()
    this.stores.closeAll()
  }

  // ---------- config ----------

  private snapshot(): ConfigSnapshot {
    const s = this.stores
    const errors: ConfigSnapshot['errors'] = {}
    if (s.servers.error) errors.servers = s.servers.error
    if (s.sets.error) errors.sets = s.sets.error
    if (s.settings.error) errors.settings = s.settings.error
    return {
      servers: s.servers.value,
      sets: s.sets.value,
      settings: s.settings.value,
      errors,
      paths: { servers: s.servers.file, sets: s.sets.file, settings: s.settings.file }
    }
  }

  private broadcastConfig() {
    this.broadcast('config:changed', this.snapshot())
  }

  private saveSecret(serverId: string, field: 'password' | 'keyPassphrase', value: string) {
    const doc = structuredClone(this.stores.servers.value)
    const s = doc.servers.find((x) => x.id === serverId)
    if (!s || s.type !== 'ssh') return
    s.auth[field] = value
    try {
      this.stores.servers.save(doc)
    } catch {
      // ignore – the connection itself succeeded
    }
  }

  private connectDeps(prompter: Prompter): ConnectDeps {
    const settings = this.stores.settings.value
    return {
      knownHosts: this.knownHosts,
      prompter,
      keepaliveInterval: settings.ssh.keepaliveInterval,
      readyTimeout: settings.ssh.connectTimeout,
      homeDir: homedir(),
      agentPaths: this.agentPaths,
      onSecretSaved: (id, field, value) => this.saveSecret(id, field, value)
    }
  }

  // ---------- windows ----------

  private windowStateFile() {
    return join(this.configDir, 'window-state.json')
  }

  private loadWindowState(): WindowState {
    try {
      if (existsSync(this.windowStateFile())) return JSON.parse(readFileSync(this.windowStateFile(), 'utf8'))
    } catch {
      // ignore
    }
    return {}
  }

  private saveWindowState(win: BrowserWindow) {
    try {
      const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
      writeFileSync(this.windowStateFile(), JSON.stringify(state))
    } catch {
      // ignore
    }
  }

  createWindow(opts: { at?: { x: number; y: number }; size?: { width: number; height: number } } = {}): BrowserWindow {
    const saved = this.loadWindowState()
    const base = opts.size ?? saved.bounds ?? { width: 1100, height: 700 }
    let pos: { x?: number; y?: number } = {}
    if (opts.at) pos = { x: Math.round(opts.at.x - TEAR_OFF_OFFSET.x), y: Math.round(opts.at.y - TEAR_OFF_OFFSET.y) }
    else if (saved.bounds && this.windows.size === 0) {
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea
        const b = saved.bounds!
        return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
      })
      if (visible) pos = { x: saved.bounds.x, y: saved.bounds.y }
    }
    const win = new BrowserWindow({
      width: base.width,
      height: base.height,
      ...pos,
      minWidth: 420,
      minHeight: 240,
      show: false,
      title: 'Prime Terminal',
      backgroundColor: '#1b1d23',
      autoHideMenuBar: true,
      icon: join(this.desktop.iconDir(), '256x256.png'),
      webPreferences: { preload: this.preloadPath, contextIsolation: true, sandbox: false, nodeIntegration: false }
    })
    const id = win.webContents.id
    this.windows.set(id, win)
    this.attached.set(id, new Set())
    this.tabs.addWindow(id)
    if (saved.maximized && !opts.at && this.windows.size === 1) win.maximize()
    win.once('ready-to-show', () => win.show())

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())

    win.on('close', (e) => {
      if (this.quitting) return
      const live = this.tabs.state(id).tabs.filter((t) => t.state !== 'closed')
      if (live.length > 0) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'question',
          buttons: ['Close', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: 'Close window',
          message: `Close this window and ${live.length} open session${live.length > 1 ? 's' : ''}?`
        })
        if (choice !== 0) {
          e.preventDefault()
          return
        }
      }
      this.saveWindowState(win)
    })
    win.on('closed', () => {
      this.windows.delete(id)
      this.attached.delete(id)
      for (const sid of this.tabs.removeWindow(id)) this.sessions.close(sid)
      if (this.windows.size === 0) {
        // last window closed → app quits (tunnels stop with it)
        app.quit()
      }
    })
    win.webContents.on('destroyed', () => this.prompts.cancelFor(win.webContents))
    this.loadRenderer(win)
    return win
  }

  private winOf(sender: WebContents): number {
    // window ids in the tab model are the ids of their WebContents
    return sender.id
  }

  /** Move a tab to another window; the target renderer re-attaches and gets the scrollback. */
  private moveTabTo(sessionId: string, toWin: number, index?: number) {
    const from = this.tabs.windowOf(sessionId)
    if (from !== null) this.attached.get(from)?.delete(sessionId)
    this.tabs.moveTab(sessionId, toWin, index)
    this.windows.get(toWin)?.focus()
  }

  private async fileDialog<T extends 'open' | 'save'>(
    sender: WebContents,
    kind: T,
    opts: T extends 'open' ? Electron.OpenDialogOptions : Electron.SaveDialogOptions
  ): Promise<string | null> {
    const win = BrowserWindow.fromWebContents(sender)
    if (kind === 'open') {
      const o = opts as Electron.OpenDialogOptions
      const r = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    }
    const o = opts as Electron.SaveDialogOptions
    const r = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o)
    return r.canceled ? null : (r.filePath ?? null)
  }

  private sendTo(winId: number, channel: string, ...args: unknown[]) {
    const w = this.windows.get(winId)
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args)
  }

  private broadcast(channel: string, ...args: unknown[]) {
    for (const id of this.windows.keys()) this.sendTo(id, channel, ...args)
  }

  private promptTarget(): WebContents | null {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && this.windows.has(focused.webContents.id)) return focused.webContents
    const first = this.windows.values().next().value as BrowserWindow | undefined
    return first?.webContents ?? null
  }

  // ---------- command line ----------

  /** Open the servers named on the command line (first start or a second `primeterminal …` call). */
  handleLaunch(args: LaunchArgs, secondInstance: boolean): void {
    let win: BrowserWindow | undefined
    if (secondInstance && (args.newWindow || args.targets.length === 0)) win = this.createWindow()
    else {
      const focused = BrowserWindow.getFocusedWindow()
      win = focused && this.windows.has(focused.webContents.id) ? focused : [...this.windows.values()].at(-1)
    }
    if (!win) win = this.createWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    const winId = win.webContents.id
    for (const t of args.targets) {
      const r = resolveLaunchTarget(t, this.stores.servers.value)
      if (r.kind === 'server') this.openSession({ serverId: r.serverId }, winId)
      else if (r.kind === 'adhoc') this.openSession({ adhoc: r.target }, winId)
      else {
        const isId = r.query.startsWith('--id=')
        const message =
          r.kind === 'ambiguous'
            ? `"${r.query}" matches several servers – pick one`
            : isId
              ? 'That server no longer exists'
              : `No server or host "${r.query}"`
        this.pendingQuick.set(winId, { query: isId ? '' : r.query, message })
        win.webContents.send('ui:quickConnectRequested')
      }
    }
  }

  // ---------- sessions ----------

  private queueData(id: string, data: string) {
    this.pendingData.set(id, (this.pendingData.get(id) ?? '') + data)
    if (this.flushScheduled) return
    this.flushScheduled = true
    setTimeout(() => {
      this.flushScheduled = false
      const batch = this.pendingData
      this.pendingData = new Map()
      for (const [sid, d] of batch) {
        const w = this.tabs.windowOf(sid)
        if (w !== null && this.attached.get(w)?.has(sid)) this.sendTo(w, 'sessions:data', sid, d)
      }
    }, 4)
  }

  private serverForTarget(target: OpenTarget): { server: ServersDoc['servers'][number] } | { error: string } {
    if ('serverId' in target) {
      const s = this.stores.servers.value.servers.find((x) => x.id === target.serverId) ?? this.adhocServers.get(target.serverId)
      return s ? { server: s } : { error: 'Server not found' }
    }
    const a = target.adhoc
    const server: SshServer = {
      id: target.save ? newId() : `adhoc-${newId()}`,
      type: 'ssh',
      name: `${a.username ?? userInfo().username}@${a.host}${a.port && a.port !== 22 ? ':' + a.port : ''}`,
      host: a.host,
      port: a.port ?? 22,
      username: a.username ?? userInfo().username,
      auth: { method: 'auto' }
    }
    if (target.save) {
      const doc = structuredClone(this.stores.servers.value)
      doc.servers.push(server)
      this.stores.servers.save(doc)
    } else this.adhocServers.set(server.id, server)
    return { server }
  }

  openSession(target: OpenTarget, winId: number, index?: number): Result {
    let found: ReturnType<PrimeApp['serverForTarget']>
    try {
      found = this.serverForTarget(target)
    } catch (e) {
      return errorResult(e)
    }
    if ('error' in found) return { ok: false, error: found.error }
    const server = found.server
    const kind = server.type
    const sessionId = this.sessions.create({
      title: server.name,
      kind,
      serverId: server.id,
      factory: () => {
        if (server.type === 'local') {
          const current = this.stores.servers.value.servers.find((s) => s.id === server.id)
          return new LocalPtyBackend(current?.type === 'local' ? current : server)
        }
        return new SshShellBackend(
          () => {
            const adhoc = this.adhocServers.get(server.id)
            return adhoc ? [adhoc] : resolveServerHops(server.id, this.stores.servers.value)
          },
          (hops) =>
            connectChain(
              hops,
              this.connectDeps(
                this.prompts.prompter(() => {
                  const w = this.tabs.windowOf(sessionId)
                  return w !== null ? (this.windows.get(w)?.webContents ?? null) : this.promptTarget()
                })
              )
            )
        )
      }
    })
    this.tabs.addTab(winId, { sessionId, title: server.name, serverId: server.id, kind, state: 'closed' }, index)
    return { ok: true }
  }

  private duplicate(sessionId: string) {
    const info = this.sessions.info(sessionId)
    const w = this.tabs.windowOf(sessionId)
    if (!info || w === null || !info.spec.serverId) return
    const idx = this.tabs.state(w).tabs.findIndex((t) => t.sessionId === sessionId)
    this.openSession({ serverId: info.spec.serverId }, w, idx + 1)
  }

  private closeTab(sessionId: string) {
    const w = this.tabs.windowOf(sessionId)
    this.tabs.removeTab(sessionId)
    if (w !== null) this.attached.get(w)?.delete(sessionId)
    this.sessions.close(sessionId)
  }

  private moveToNewWindow(sessionId: string, at?: { x: number; y: number }) {
    const from = this.tabs.windowOf(sessionId)
    if (from === null) return
    const src = this.windows.get(from)
    const size = src ? { width: src.getBounds().width, height: src.getBounds().height } : undefined
    const win = this.createWindow({ at: at ?? (src ? { x: src.getBounds().x + 160, y: src.getBounds().y + 60 } : undefined), size })
    this.moveTabTo(sessionId, win.webContents.id)
  }

  /** Window whose tab-bar zone contains the point (focused window first for overlaps). */
  private tabBarAtPoint(p: { x: number; y: number }): number | null {
    const focused = BrowserWindow.getFocusedWindow()
    const ordered = [...this.windows].sort(([, a]) => (a === focused ? -1 : 0))
    for (const [id, w] of ordered) {
      if (w.isMinimized() || !w.isVisible()) continue
      const b = w.getContentBounds()
      if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + TAB_BAR_ZONE) return id
    }
    return null
  }

  /**
   * A tab drag ended without a drop on a tab bar (drops are handled in 'tabs:drop').
   * Over some window's tab bar → move there (or keep); anywhere else → tear off into a new window.
   */
  private finishDrag(sessionId: string) {
    const d = this.dragging
    if (!d || d.sessionId !== sessionId) return
    this.dragging = null
    if (d.dropped) return
    const p = screen.getCursorScreenPoint()
    const over = this.tabBarAtPoint(p)
    if (over === d.fromWin) return
    if (over !== null) return this.moveTabTo(sessionId, over)
    if (this.tabs.state(d.fromWin).tabs.length <= 1) {
      // single tab: just move its window
      this.windows.get(d.fromWin)?.setPosition(Math.round(p.x - TEAR_OFF_OFFSET.x), Math.round(p.y - TEAR_OFF_OFFSET.y))
      return
    }
    this.moveToNewWindow(sessionId, p)
  }

  // ---------- IPC ----------

  private registerIpc() {
    const h = ipcMain.handle.bind(ipcMain)
    const on = ipcMain.on.bind(ipcMain)

    h('config:get', () => this.snapshot())
    const saveDoc = (store: { save(v: never): void }, doc: unknown): Result => {
      try {
        store.save(doc as never)
        return { ok: true }
      } catch (e) {
        return errorResult(e)
      }
    }
    h('config:saveServers', (_e, doc: ServersDoc) => saveDoc(this.stores.servers, doc))
    h('config:saveSets', (_e, doc: ForwardSetsDoc) => saveDoc(this.stores.sets, doc))
    h('config:readText', (_e, kind: ConfigFileKind) => this.stores.byKind[kind].readText())
    h('config:saveText', (_e, kind: ConfigFileKind, text: string) => this.stores.byKind[kind].saveText(text))
    h('config:importSshConfig', () => {
      const file = join(homedir(), '.ssh', 'config')
      if (!existsSync(file)) return { ok: false, error: `${file} not found` }
      try {
        const r = importSshConfig(readFileSync(file, 'utf8'), this.stores.servers.value, userInfo().username)
        if (r.added > 0) this.stores.servers.save(r.doc)
        return { ok: true, added: r.added, warnings: r.warnings }
      } catch (e) {
        return errorResult(e)
      }
    })
    h('config:pickKeyFile', async (e) => {
      const p = await this.fileDialog(e.sender, 'open', {
        title: 'Choose private key',
        defaultPath: join(homedir(), '.ssh'),
        properties: ['openFile', 'showHiddenFiles']
      })
      if (!p) return null
      const home = homedir()
      return p.startsWith(home) ? '~' + p.slice(home.length).replace(/\\/g, '/') : p
    })
    const jsonFilter = [{ name: 'JSON', extensions: ['json'] }]
    h('config:exportText', async (e, name: string, text: string) => {
      const p = await this.fileDialog(e.sender, 'save', { defaultPath: name, filters: jsonFilter })
      if (!p) return false
      writeFileSync(p, text)
      return true
    })
    h('config:importText', async (e) => {
      const p = await this.fileDialog(e.sender, 'open', { filters: jsonFilter, properties: ['openFile'] })
      return p ? readFileSync(p, 'utf8') : null
    })

    const backupFilters = [
      { name: 'Prime Terminal backup', extensions: [BACKUP_EXTENSION, 'zip'] },
      { name: 'All files', extensions: ['*'] }
    ]
    h('backup:export', async (e, password?: string) => {
      const date = new Date().toISOString().slice(0, 10)
      const p = await this.fileDialog(e.sender, 'save', {
        title: 'Export configuration',
        defaultPath: join(homedir(), `prime-terminal-${date}.${BACKUP_EXTENSION}`),
        filters: backupFilters
      })
      if (!p) return null
      try {
        const s = this.stores
        writeFileSync(p, createBackup({ servers: s.servers.value, sets: s.sets.value, settings: s.settings.value }, password || undefined), { mode: 0o600 })
        return { ok: true, path: p }
      } catch (err) {
        return errorResult(err)
      }
    })
    h('backup:pick', async (e) => {
      const p = await this.fileDialog(e.sender, 'open', { title: 'Import configuration', filters: backupFilters, properties: ['openFile'] })
      if (!p) return null
      try {
        const data = new Uint8Array(readFileSync(p))
        const info = inspectBackup(data)
        const token = newId()
        this.pendingBackups.clear()
        this.pendingBackups.set(token, data)
        return { ok: true, token, path: p, info }
      } catch (err) {
        return errorResult(err)
      }
    })
    h('backup:import', async (_e, token: string, opts: { password?: string; mode: 'merge' | 'replace' }) => {
      const data = this.pendingBackups.get(token)
      if (!data) return { ok: false, error: 'Choose the backup file again' }
      try {
        const s = this.stores
        const incoming = readBackup(data, opts.password || undefined)
        const result = applyBackup({ servers: s.servers.value, sets: s.sets.value, settings: s.settings.value }, incoming, opts.mode)
        // stop tunnels of sets that no longer exist
        const remaining = new Set(result.sets.sets.map((x) => x.id))
        for (const set of s.sets.value.sets) if (!remaining.has(set.id)) await this.tunnels.deactivate(set.id)
        s.servers.save(result.servers)
        s.sets.save(result.sets)
        if (opts.mode === 'replace') s.settings.save(result.settings)
        this.pendingBackups.delete(token)
        return { ok: true }
      } catch (err) {
        return errorResult(err)
      }
    })

    h('sessions:open', (e, target: OpenTarget, opts?: { newWindow?: boolean; afterSessionId?: string }) => {
      let winId = this.winOf(e.sender)
      if (opts?.newWindow) winId = this.createWindow().webContents.id
      let index: number | undefined
      if (opts?.afterSessionId) {
        const i = this.tabs.state(winId).tabs.findIndex((t) => t.sessionId === opts.afterSessionId)
        if (i >= 0) index = i + 1
      }
      return this.openSession(target, winId, index)
    })
    h('sessions:attach', (e, id: string, cols: number, rows: number) => {
      const w = this.winOf(e.sender)
      this.pendingData.delete(id)
      this.attached.get(w)?.add(id)
      const snapshot = this.sessions.snapshot(id)
      this.sessions.resize(id, cols, rows)
      if (!this.started.has(id) && this.sessions.has(id)) {
        // sessions start on first attach, so the PTY gets the real terminal size
        this.started.add(id)
        this.sessions.start(id)
      }
      return { snapshot }
    })
    on('sessions:detach', (e, id: string) => this.attached.get(this.winOf(e.sender))?.delete(id))
    on('sessions:write', (_e, id: string, data: string) => this.sessions.write(id, data))
    on('sessions:resize', (_e, id: string, cols: number, rows: number) => this.sessions.resize(id, cols, rows))

    h('tabs:get', (e) => this.tabs.state(this.winOf(e.sender)))
    on('tabs:activate', (_e, id: string) => this.tabs.setActive(id))
    on('tabs:close', (_e, id: string) => this.closeTab(id))
    on('tabs:closeOthers', (_e, id: string) => {
      const w = this.tabs.windowOf(id)
      if (w === null) return
      for (const t of this.tabs.state(w).tabs) if (t.sessionId !== id) this.closeTab(t.sessionId)
    })
    on('tabs:reorder', (_e, id: string, index: number) => this.tabs.reorder(id, index))
    on('tabs:moveBy', (_e, id: string, delta: number) => this.tabs.moveBy(id, delta))
    on('tabs:cycle', (e, delta: number) => this.tabs.cycle(this.winOf(e.sender), delta))
    on('tabs:activateIndex', (e, index: number) => this.tabs.activateIndex(this.winOf(e.sender), index))
    on('tabs:rename', (_e, id: string, title: string) => this.tabs.rename(id, title))
    on('tabs:duplicate', (_e, id: string) => this.duplicate(id))
    on('tabs:moveToNewWindow', (_e, id: string) => this.moveToNewWindow(id))
    on('tabs:dragStart', (e, id: string) => {
      this.dragging = { sessionId: id, fromWin: this.winOf(e.sender), dropped: false }
    })
    on('tabs:dragEnd', (_e, id: string) => {
      // give a drop event from another window time to arrive first
      setTimeout(() => this.finishDrag(id), 150)
    })
    on('tabs:drop', (e, index: number) => {
      const d = this.dragging
      if (!d) return
      d.dropped = true
      const to = this.winOf(e.sender)
      if (to === d.fromWin) this.tabs.reorder(d.sessionId, index)
      else this.moveTabTo(d.sessionId, to, index)
    })

    on('windows:new', () => this.createWindow())
    h('ui:takeQuickConnect', (e) => {
      const p = this.pendingQuick.get(e.sender.id) ?? null
      this.pendingQuick.delete(e.sender.id)
      return p
    })

    h('desktop:get', () => this.desktop.status())
    h('desktop:apply', async (_e, opts: IntegrationOptions) => {
      try {
        await this.desktop.apply(opts)
        return { ok: true }
      } catch (err) {
        return errorResult(err)
      }
    })
    h('desktop:remove', async () => {
      try {
        await this.desktop.remove()
        return { ok: true }
      } catch (err) {
        return errorResult(err)
      }
    })
    on('desktop:dismiss', () => this.desktop.dismiss())
    on('windows:setTitle', (e, title: string) => BrowserWindow.fromWebContents(e.sender)?.setTitle(title))

    h('tunnels:status', () => this.stores.sets.value.sets.map((s) => this.tunnels.status(s.id)))
    h('tunnels:activate', (_e, id: string) => this.tunnels.activate(id))
    h('tunnels:deactivate', (_e, id: string) => {
      this.tunnels.clear(id)
      return this.tunnels.deactivate(id)
    })

    on('prompts:respond', (_e, id: string, resp) => this.prompts.respond(id, resp))
    on('prompts:ready', (e) => this.prompts.markReady(e.sender))

    h('ui:contextMenu', (e, items: MenuItemSpec[]) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      return new Promise<string | null>((resolve) => {
        let done = false
        const finish = (v: string | null) => {
          if (!done) {
            done = true
            resolve(v)
          }
        }
        const menu = Menu.buildFromTemplate(
          items.map((i) =>
            i.type === 'separator'
              ? { type: 'separator' as const }
              : {
                  label: i.label,
                  type: i.type === 'checkbox' ? ('checkbox' as const) : ('normal' as const),
                  checked: i.checked,
                  enabled: i.enabled !== false,
                  accelerator: i.accelerator,
                  registerAccelerator: false,
                  click: () => finish(i.id ?? null)
                }
          )
        )
        menu.popup({ window: win, callback: () => setTimeout(() => finish(null), 50) })
      })
    })
    h('ui:clipboardRead', () => clipboard.readText())
    on('ui:clipboardWrite', (_e, text: string) => clipboard.writeText(text))
    on('ui:openExternal', (_e, url: string) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    })
  }
}
