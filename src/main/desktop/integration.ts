// Desktop integration for the portable builds:
//  Linux (GNOME & co.): launcher + icon in ~/.local/share (servers as right-click actions), a GNOME
//    search provider that lists saved servers as results of Prime Terminal, and a `primeterminal`
//    command in ~/.local/bin.
//  Windows: Start-menu shortcut (Windows search), `primeterminal` command; the taskbar jump list
//    always lists the servers.
// Every created file is tracked so it can be refreshed (AppImage moved) or removed again.

import { execFile, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, shell } from 'electron'
import type { ServersDoc } from '../../shared/types'
import { CLI_NAME, linuxPlan, MAX_ACTIONS } from './entries'
import {
  SEARCH_BUS_NAME,
  SEARCH_INI_NAME,
  searchProviderIni,
  searchProviderScript,
  searchProviderService,
  userSearchProviderBase
} from './searchProvider'

export interface IntegrationOptions {
  /** GNOME: servers as search results (Linux only) */
  searchProvider: boolean
  cliCommand: boolean
}

interface State extends IntegrationOptions {
  enabled: boolean
  /** the first-start question was answered */
  asked: boolean
  files: string[]
  /** files installed with administrator rights (removed with pkexec) */
  systemFiles: string[]
}

/** Where the search provider can be registered. */
export type SearchProviderSupport = 'user' | 'system' | 'unavailable'

export interface IntegrationStatus extends IntegrationOptions {
  supported: boolean
  platform: NodeJS.Platform
  enabled: boolean
  askOnStart: boolean
  command: string[]
  portable: boolean
  searchProviderSupport: SearchProviderSupport
  searchProviderNote: string
  /** installed by a system package (.deb): launcher, search provider and command already exist */
  installed: boolean
}

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
/** App-grid folder created by an earlier version (per-server launchers); cleaned up. */
const OLD_APP_FOLDER = 'prime-terminal-servers'
const SYSTEM_DATA_DIR = '/usr/local/share'

const run = (cmd: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(cmd, args, { timeout: 60000 }, (err, out) => resolve({ ok: !err, out: String(out ?? '') }))
  )

function writable(dir: string): boolean {
  try {
    if (!existsSync(dir)) return writable(dirname(dir))
    accessSync(dir, constants.W_OK)
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** XDG_DATA_DIRS of the running GNOME Shell (that is where it looks for search providers). */
function gnomeShellDataDirs(): string[] | null {
  if (process.platform !== 'linux') return null
  try {
    const uid = process.getuid?.()
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      try {
        if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'gnome-shell') continue
        if (uid !== undefined && statSync(`/proc/${pid}`).uid !== uid) continue
        const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
        const v = env.find((e) => e.startsWith('XDG_DATA_DIRS='))?.slice('XDG_DATA_DIRS='.length)
        return (v || '/usr/local/share:/usr/share').split(':').filter(Boolean)
      } catch {
        continue
      }
    }
  } catch {
    // no /proc
  }
  return null
}

let pythonGiCache: boolean | null = null
function hasPythonGi(): boolean {
  if (pythonGiCache === null) {
    pythonGiCache = spawnSync('python3', ['-c', "import gi; gi.require_version('Gio', '2.0')"], { timeout: 5000 }).status === 0
  }
  return pythonGiCache
}

export class DesktopIntegration {
  private state: State
  private syncTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly stateFile: string,
    private readonly serversFile: string,
    private readonly servers: () => ServersDoc
  ) {
    this.state = { enabled: false, asked: false, searchProvider: true, cliCommand: true, files: [], systemFiles: [] }
    try {
      if (existsSync(stateFile)) this.state = { ...this.state, ...JSON.parse(readFileSync(stateFile, 'utf8')) }
    } catch {
      // keep defaults
    }
  }

  private save() {
    try {
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
    } catch {
      // ignore
    }
  }

  /** How this app is started (what launchers and the CLI wrapper execute). */
  command(): string[] {
    if (process.platform === 'linux' && process.env.APPIMAGE) return [process.env.APPIMAGE]
    if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_FILE) return [process.env.PORTABLE_EXECUTABLE_FILE]
    if (app.isPackaged) return [process.execPath]
    return [process.execPath, app.getAppPath()]
  }

  private portable(): boolean {
    return !!(process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE)
  }

  private installed(): boolean {
    return process.platform === 'linux' && app.isPackaged && !process.env.APPIMAGE
  }

  iconDir(): string {
    return app.isPackaged ? join(process.resourcesPath, 'icons') : join(app.getAppPath(), 'build/icons')
  }

  private searchSupport(): { support: SearchProviderSupport; note: string; userBase: string | null } {
    if (process.platform !== 'linux') return { support: 'unavailable', note: 'Only available on Linux with GNOME.', userBase: null }
    const dirs = gnomeShellDataDirs()
    if (!dirs) return { support: 'unavailable', note: 'GNOME Shell is not running.', userBase: null }
    if (!hasPythonGi()) return { support: 'unavailable', note: 'Needs python3 with GObject introspection (python3-gi).', userBase: null }
    const userBase = userSearchProviderBase(dirs, homedir(), writable)
    if (userBase) return { support: 'user', note: '', userBase }
    return { support: 'system', note: 'Registering with GNOME asks once for the administrator password.', userBase: null }
  }

  status(): IntegrationStatus {
    const supported = process.platform === 'linux' || process.platform === 'win32'
    const sp = this.searchSupport()
    return {
      supported,
      platform: process.platform,
      enabled: this.state.enabled,
      searchProvider: this.state.searchProvider,
      cliCommand: this.state.cliCommand,
      askOnStart: supported && !this.state.asked && !this.state.enabled && this.portable(),
      installed: this.installed(),
      command: this.command(),
      portable: this.portable(),
      searchProviderSupport: sp.support,
      searchProviderNote: sp.note
    }
  }

  dismiss(): void {
    this.state.asked = true
    this.save()
  }

  async apply(opts: IntegrationOptions): Promise<void> {
    this.state = { ...this.state, ...opts, enabled: true, asked: true }
    try {
      await this.write(true)
    } finally {
      this.save()
    }
  }

  async remove(): Promise<void> {
    for (const f of this.state.files) rmSync(f, { force: true })
    if (process.platform === 'linux') {
      if (this.state.systemFiles.length) await this.privileged(['rm', '-f', ...this.state.systemFiles])
      await this.setOldAppFolderGone()
      await this.refreshLinux()
    }
    if (process.platform === 'win32') rmSync(this.startMenuDir(), { recursive: true, force: true })
    this.state = { ...this.state, enabled: false, asked: true, files: [], systemFiles: [] }
    this.save()
  }

  /** Re-generate after server changes or when the AppImage/exe was moved. Debounced. */
  scheduleSync(delay = 1500): void {
    if (process.platform === 'win32') this.updateJumpList()
    if (!this.state.enabled) return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      // never ask for a password in the background
      void this.write(false).then(() => this.save(), () => this.save())
    }, delay)
  }

  private async write(interactive: boolean): Promise<void> {
    const created = process.platform === 'linux' ? await this.writeLinux(interactive) : process.platform === 'win32' ? this.writeWindows() : []
    const keep = new Set(created)
    for (const old of this.state.files) if (!keep.has(old)) rmSync(old, { force: true })
    this.state.files = created
  }

  // ---------- Linux ----------

  private async writeLinux(interactive: boolean): Promise<string[]> {
    const home = homedir()
    const plan = linuxPlan({
      home,
      command: this.command(),
      servers: this.servers(),
      iconSizes: ICON_SIZES,
      iconDir: this.iconDir(),
      cliCommand: this.state.cliCommand
    })
    const written: string[] = []
    const put = (path: string, content: string, mode?: number) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      if (mode) chmodSync(path, mode)
      written.push(path)
    }
    for (const f of plan.files) put(f.path, f.content, f.mode)
    for (const c of plan.copies) {
      if (!existsSync(c.from)) continue
      mkdirSync(dirname(c.to), { recursive: true })
      copyFileSync(c.from, c.to)
      written.push(c.to)
    }

    let providerChanged = false
    const sp = this.searchSupport()
    if (this.state.searchProvider && sp.support !== 'unavailable') {
      const script = join(home, '.local/share/prime-terminal/search-provider.py')
      put(script, searchProviderScript({ serversFile: this.serversFile, command: this.command() }), 0o755)
      put(join(home, '.local/share/dbus-1/services', `${SEARCH_BUS_NAME}.service`), searchProviderService('/usr/bin/env python3', script))
      if (sp.userBase) {
        const ini = join(sp.userBase, 'gnome-shell/search-providers', SEARCH_INI_NAME)
        providerChanged = !existsSync(ini)
        put(ini, searchProviderIni())
      } else {
        const ini = join(SYSTEM_DATA_DIR, 'gnome-shell/search-providers', SEARCH_INI_NAME)
        if (!existsSync(ini) && interactive) {
          const tmp = join(tmpdir(), `${SEARCH_INI_NAME}.${process.pid}`)
          writeFileSync(tmp, searchProviderIni())
          const r = await this.privileged(['install', '-D', '-m', '644', tmp, ini])
          rmSync(tmp, { force: true })
          if (!r.ok) throw new Error('Registering the search provider needs administrator rights (cancelled or failed).')
          providerChanged = true
        }
        if (existsSync(ini) && !this.state.systemFiles.includes(ini)) this.state.systemFiles.push(ini)
      }
    } else if (this.state.systemFiles.length && interactive) {
      const r = await this.privileged(['rm', '-f', ...this.state.systemFiles])
      if (r.ok) this.state.systemFiles = []
    }

    await this.setOldAppFolderGone()
    await this.refreshLinux()
    if (providerChanged) await this.reloadGnomeSearchProviders()
    return written
  }

  private privileged(args: string[]) {
    return run('pkexec', args)
  }

  private async refreshLinux() {
    await run('update-desktop-database', [join(homedir(), '.local/share/applications')])
    await run('gtk-update-icon-cache', ['-f', '-t', join(homedir(), '.local/share/icons/hicolor')])
  }

  /** GNOME Shell re-reads search providers when these settings change. */
  private async reloadGnomeSearchProviders() {
    const key = ['org.gnome.desktop.search-providers', 'disable-external']
    const cur = await run('gsettings', ['get', ...key])
    if (!cur.ok) return
    const value = cur.out.trim() === 'true'
    await run('gsettings', ['set', ...key, String(!value)])
    await run('gsettings', ['set', ...key, String(value)])
  }

  /** Remove the app-grid folder an earlier version created for per-server launchers. */
  private async setOldAppFolderGone(): Promise<void> {
    const r = await run('gsettings', ['get', 'org.gnome.desktop.app-folders', 'folder-children'])
    if (!r.ok) return
    const children = [...r.out.matchAll(/'([^']*)'/g)].map((m) => m[1])
    if (!children.includes(OLD_APP_FOLDER)) return
    const list = children.filter((c) => c !== OLD_APP_FOLDER).map((x) => `'${x}'`)
    await run('gsettings', ['set', 'org.gnome.desktop.app-folders', 'folder-children', `[${list.join(', ')}]`])
    const schema = `org.gnome.desktop.app-folders.folder:/org/gnome/desktop/app-folders/folders/${OLD_APP_FOLDER}/`
    await run('gsettings', ['reset', schema, 'apps'])
    await run('gsettings', ['reset', schema, 'name'])
  }

  // ---------- Windows ----------

  private startMenuDir(): string {
    return join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Prime Terminal')
  }

  private writeWindows(): string[] {
    const [exe, ...baseArgs] = this.command()
    const written: string[] = []
    const dir = this.startMenuDir()
    // remove per-server shortcuts of earlier versions
    rmSync(join(dir, 'Servers'), { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const lnk = join(dir, 'Prime Terminal.lnk')
    const ok = shell.writeShortcutLink(lnk, 'replace', {
      target: exe,
      args: baseArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
      description: 'SSH client',
      icon: exe,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID
    })
    if (ok) written.push(lnk)
    if (this.state.cliCommand && process.env.LOCALAPPDATA) {
      // %LOCALAPPDATA%\Microsoft\WindowsApps is on the user's PATH by default
      const cmd = join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', `${CLI_NAME}.cmd`)
      try {
        const quoted = [exe, ...baseArgs].map((a) => `"${a}"`).join(' ')
        writeFileSync(cmd, `@echo off\r\nstart "" ${quoted} %*\r\n`)
        written.push(cmd)
      } catch {
        // folder missing or not writable
      }
    }
    return written
  }

  updateJumpList(): void {
    if (process.platform !== 'win32') return
    const [exe, ...baseArgs] = this.command()
    const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a)
    const servers = this.servers().servers.filter((s) => !(s.type === 'local' && s.hidden)).slice(0, MAX_ACTIONS)
    try {
      app.setJumpList([
        {
          type: 'custom',
          name: 'Servers',
          items: servers.map((s) => ({
            type: 'task' as const,
            title: s.name,
            description: s.type === 'ssh' ? `${s.username}@${s.host}` : 'Local shell',
            program: exe,
            args: [...baseArgs, `--id=${s.id}`].map(quote).join(' '),
            iconPath: exe,
            iconIndex: 0
          }))
        },
        {
          type: 'tasks',
          items: [{ type: 'task', title: 'New window', program: exe, args: [...baseArgs, '--new-window'].map(quote).join(' '), iconPath: exe, iconIndex: 0, description: 'Open a new window' }]
        }
      ])
    } catch {
      // jump lists are best effort
    }
  }
}

export const APP_USER_MODEL_ID = 'dev.prime-terminal.app'
