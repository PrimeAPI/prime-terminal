// Desktop integration for the portable builds:
//  Linux (GNOME & co.): launcher + icon in ~/.local/share, optional per-server launchers (found by
//    the desktop search, grouped in a GNOME app folder) and a `primeterminal` command in ~/.local/bin.
//  Windows: Start-menu shortcuts (found by Windows search), per-server shortcuts and a
//    `primeterminal` command; the taskbar jump list always lists the servers.
// Every created file is tracked so that it can be updated (AppImage moved) or removed again.

import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, shell } from 'electron'
import type { ServersDoc } from '../../shared/types'
import { CLI_NAME, linuxPlan, MAX_ACTIONS, windowsShortcutName } from './entries'

export interface IntegrationOptions {
  serverLaunchers: boolean
  cliCommand: boolean
}

interface State extends IntegrationOptions {
  enabled: boolean
  /** the first-start question was answered */
  asked: boolean
  files: string[]
}

export interface IntegrationStatus extends IntegrationOptions {
  supported: boolean
  platform: NodeJS.Platform
  enabled: boolean
  askOnStart: boolean
  command: string[]
  portable: boolean
}

const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
const APP_FOLDER = 'prime-terminal-servers'
const run = (cmd: string, args: string[]) =>
  new Promise<void>((resolve) => execFile(cmd, args, { timeout: 5000 }, () => resolve()))

export class DesktopIntegration {
  private state: State
  private syncTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly stateFile: string,
    private readonly servers: () => ServersDoc
  ) {
    this.state = { enabled: false, asked: false, serverLaunchers: true, cliCommand: true, files: [] }
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

  iconDir(): string {
    return app.isPackaged ? join(process.resourcesPath, 'icons') : join(app.getAppPath(), 'build/icons')
  }

  status(): IntegrationStatus {
    const supported = process.platform === 'linux' || process.platform === 'win32'
    return {
      supported,
      platform: process.platform,
      enabled: this.state.enabled,
      serverLaunchers: this.state.serverLaunchers,
      cliCommand: this.state.cliCommand,
      askOnStart: supported && !this.state.asked && !this.state.enabled && this.portable(),
      command: this.command(),
      portable: this.portable()
    }
  }

  dismiss(): void {
    this.state.asked = true
    this.save()
  }

  async apply(opts: IntegrationOptions): Promise<void> {
    this.state = { ...this.state, ...opts, enabled: true, asked: true }
    await this.write()
    this.save()
  }

  async remove(): Promise<void> {
    for (const f of this.state.files) rmSync(f, { force: true })
    if (process.platform === 'linux') {
      await this.setAppFolder([])
      await this.refreshLinuxCaches()
    }
    if (process.platform === 'win32') rmSync(this.startMenuDir(), { recursive: true, force: true })
    this.state = { ...this.state, enabled: false, asked: true, files: [] }
    this.save()
  }

  /** Re-generate after server changes or when the AppImage/exe was moved. Debounced. */
  scheduleSync(delay = 1500): void {
    if (process.platform === 'win32') this.updateJumpList()
    if (!this.state.enabled) return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.write().then(() => this.save())
    }, delay)
  }

  private async write(): Promise<void> {
    const created = process.platform === 'linux' ? await this.writeLinux() : process.platform === 'win32' ? this.writeWindows() : []
    const keep = new Set(created)
    for (const old of this.state.files) if (!keep.has(old)) rmSync(old, { force: true })
    this.state.files = created
  }

  // ---------- Linux ----------

  private async writeLinux(): Promise<string[]> {
    const plan = linuxPlan({
      home: homedir(),
      command: this.command(),
      servers: this.servers(),
      iconSizes: ICON_SIZES,
      iconDir: this.iconDir(),
      serverLaunchers: this.state.serverLaunchers,
      cliCommand: this.state.cliCommand
    })
    const written: string[] = []
    for (const f of plan.files) {
      mkdirSync(dirname(f.path), { recursive: true })
      writeFileSync(f.path, f.content)
      if (f.mode) chmodSync(f.path, f.mode)
      written.push(f.path)
    }
    for (const c of plan.copies) {
      if (!existsSync(c.from)) continue
      mkdirSync(dirname(c.to), { recursive: true })
      copyFileSync(c.from, c.to)
      written.push(c.to)
    }
    await this.setAppFolder(plan.appFolderApps)
    await this.refreshLinuxCaches()
    return written
  }

  private async refreshLinuxCaches() {
    await run('update-desktop-database', [join(homedir(), '.local/share/applications')])
    await run('gtk-update-icon-cache', ['-f', '-t', join(homedir(), '.local/share/icons/hicolor')])
  }

  /** Group the server launchers in one GNOME app-grid folder (best effort; no-op outside GNOME). */
  private async setAppFolder(apps: string[]): Promise<void> {
    const gsettings = ['/usr/bin/gsettings', '/bin/gsettings'].find((p) => existsSync(p))
    if (!gsettings) return
    const children = await new Promise<string[] | null>((resolve) =>
      execFile(gsettings, ['get', 'org.gnome.desktop.app-folders', 'folder-children'], { timeout: 5000 }, (err, out) => {
        if (err) return resolve(null)
        resolve([...out.matchAll(/'([^']*)'/g)].map((m) => m[1]))
      })
    )
    if (!children) return
    const list = (xs: string[]) => `[${xs.map((x) => `'${x}'`).join(', ')}]`
    const schema = `org.gnome.desktop.app-folders.folder:/org/gnome/desktop/app-folders/folders/${APP_FOLDER}/`
    if (apps.length) {
      await run(gsettings, ['set', schema, 'name', 'Prime Terminal servers'])
      await run(gsettings, ['set', schema, 'apps', list(apps)])
      if (!children.includes(APP_FOLDER)) await run(gsettings, ['set', 'org.gnome.desktop.app-folders', 'folder-children', list([...children, APP_FOLDER])])
    } else if (children.includes(APP_FOLDER)) {
      await run(gsettings, ['set', 'org.gnome.desktop.app-folders', 'folder-children', list(children.filter((c) => c !== APP_FOLDER))])
      await run(gsettings, ['reset', schema, 'apps'])
      await run(gsettings, ['reset', schema, 'name'])
    }
  }

  // ---------- Windows ----------

  private startMenuDir(): string {
    return join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Prime Terminal')
  }

  private writeWindows(): string[] {
    const [exe, ...baseArgs] = this.command()
    const written: string[] = []
    const link = (path: string, args: string[], description: string) => {
      mkdirSync(dirname(path), { recursive: true })
      const ok = shell.writeShortcutLink(path, 'replace', {
        target: exe,
        args: [...baseArgs, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
        description,
        icon: exe,
        iconIndex: 0,
        appUserModelId: APP_USER_MODEL_ID
      })
      if (ok) written.push(path)
    }
    const dir = this.startMenuDir()
    link(join(dir, 'Prime Terminal.lnk'), [], 'SSH client')
    if (this.state.serverLaunchers) {
      const used = new Set<string>()
      for (const s of this.servers().servers.filter((x) => !(x.type === 'local' && x.hidden))) {
        let name = windowsShortcutName(s.name)
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${windowsShortcutName(s.name)} (${n})`
        used.add(name.toLowerCase())
        link(join(dir, 'Servers', `${name}.lnk`), [`--id=${s.id}`], s.type === 'ssh' ? `SSH ${s.username}@${s.host}` : 'Local shell')
      }
    }
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
            args: [...baseArgs, `--id=${s.id}`].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
            iconPath: exe,
            iconIndex: 0
          }))
        },
        { type: 'tasks', items: [{ type: 'task', title: 'New window', program: exe, args: [...baseArgs, '--new-window'].join(' '), iconPath: exe, iconIndex: 0, description: 'Open a new window' }] }
      ])
    } catch {
      // jump lists are best effort
    }
  }
}

export const APP_USER_MODEL_ID = 'dev.prime-terminal.app'
