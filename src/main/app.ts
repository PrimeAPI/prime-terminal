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
import { PromptService } from './prompts'
import { LocalPtyBackend, SshShellBackend } from './sessions/backends'
import { SessionManager } from './sessions/sessionManager'
import { detectShellsOnThisMachine, mergeDetectedShells } from './shells/detect'
import { detectAgentPath } from './ssh/agent'
import { connectChain, type ConnectDeps, type Prompter } from './ssh/connect'
import { KnownHosts } from './ssh/knownHosts'
import { importSshConfig } from './ssh/sshConfigImport'
import { TunnelManager } from './tunnels/tunnelManager'
import { TabModel } from './windows/tabModel'

interface WindowState {
  bounds?: { x: number; y: number; width: number; height: number }
  maximized?: boolean
}

type Result = { ok: true } | { ok: false; error: string }
const errorResult = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : String(e) })

export class PrimeApp {
  readonly stores: ConfigStores
  readonly sessions = new SessionManager()
  readonly tabs = new TabModel()
  readonly prompts = new PromptService()
  readonly tunnels: TunnelManager
  private windows = new Map<number, BrowserWindow>()
  /** sessions each renderer currently shows (data is only sent for these) */
  private attached = new Map<number, Set<string>>()
  private pendingData = new Map<string, string>()
  private flushScheduled = false
  private dragging: { sessionId: string; fromWin: number; dropped: boolean } | null = null
  private adhocServers = new Map<string, SshServer>()
  private quitting = false
  private started = new Set<string>()
  private knownHosts = new KnownHosts(join(homedir(), '.ssh', 'known_hosts'))
  private agentPath = detectAgentPath()

  constructor(
    private readonly configDir: string,
    private readonly preloadPath: string,
    private readonly loadRenderer: (win: BrowserWindow) => void
  ) {
    this.stores = createConfigStores(configDir)
    this.tunnels = new TunnelManager({
      getSet: (id) => this.stores.sets.value.sets.find((s) => s.id === id),
      resolveHops: (set) => resolveSetHops(set, this.stores.servers.value),
      connect: (hops) => connectChain(hops, this.connectDeps(this.prompts.prompter(() => this.promptTarget()))),
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
      agentPath: this.agentPath,
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
    if (opts.at) pos = { x: Math.round(opts.at.x - 120), y: Math.round(opts.at.y - 16) }
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
    return sender.id
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
    this.attached.get(from)?.delete(sessionId)
    this.tabs.moveTab(sessionId, win.webContents.id)
  }

  private windowAtPoint(p: { x: number; y: number }): number | null {
    for (const [id, w] of this.windows) {
      const b = w.getBounds()
      if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height && !w.isMinimized()) return id
    }
    return null
  }

  private finishDrag(sessionId: string) {
    const d = this.dragging
    if (!d || d.sessionId !== sessionId) return
    this.dragging = null
    if (d.dropped) return
    const p = screen.getCursorScreenPoint()
    const over = this.windowAtPoint(p)
    if (over === d.fromWin) return
    if (over !== null) {
      this.attached.get(d.fromWin)?.delete(sessionId)
      this.tabs.moveTab(sessionId, over)
      this.windows.get(over)?.focus()
      return
    }
    // dropped outside of any window → tear off
    if (this.tabs.state(d.fromWin).tabs.length <= 1) {
      this.windows.get(d.fromWin)?.setPosition(Math.round(p.x - 120), Math.round(p.y - 16))
      return
    }
    this.moveToNewWindow(sessionId, p)
  }

  // ---------- IPC ----------

  private registerIpc() {
    const h = ipcMain.handle.bind(ipcMain)
    const on = ipcMain.on.bind(ipcMain)

    h('config:get', () => this.snapshot())
    h('config:saveServers', (_e, doc: ServersDoc) => {
      try {
        this.stores.servers.save(doc)
        return { ok: true }
      } catch (e) {
        return errorResult(e)
      }
    })
    h('config:saveSets', (_e, doc: ForwardSetsDoc) => {
      try {
        this.stores.sets.save(doc)
        return { ok: true }
      } catch (e) {
        return errorResult(e)
      }
    })
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
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = { title: 'Choose private key', defaultPath: join(homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] as ('openFile' | 'showHiddenFiles')[] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      const p = r.filePaths[0]
      const home = homedir()
      return p.startsWith(home) ? '~' + p.slice(home.length).replace(/\\/g, '/') : p
    })
    h('config:exportText', async (e, name: string, text: string) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = { defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return false
      writeFileSync(r.filePath, text)
      return true
    })
    h('config:importText', async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] as 'openFile'[] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      return readFileSync(r.filePaths[0], 'utf8')
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
      else {
        this.attached.get(d.fromWin)?.delete(d.sessionId)
        this.tabs.moveTab(d.sessionId, to, index)
        this.windows.get(to)?.focus()
      }
    })

    on('windows:new', () => this.createWindow())
    on('windows:setTitle', (e, title: string) => BrowserWindow.fromWebContents(e.sender)?.setTitle(title))

    h('tunnels:status', () => this.stores.sets.value.sets.map((s) => this.tunnels.status(s.id)))
    h('tunnels:activate', (_e, id: string) => this.tunnels.activate(id))
    h('tunnels:deactivate', (_e, id: string) => {
      this.tunnels.clear(id)
      return this.tunnels.deactivate(id)
    })

    on('prompts:respond', (_e, id: string, resp) => this.prompts.respond(id, resp))

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
