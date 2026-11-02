// Pure generators for desktop integration files (Linux .desktop entries, CLI wrapper, names).

import { join } from 'node:path'
import type { ServersDoc, Server } from '../../shared/types'
import { folderPath } from '../../shared/folders'

export const APP_ID = 'prime-terminal'
export const CLI_NAME = 'primeterminal'
/** Max. servers offered in the launcher's right-click menu. */
export const MAX_ACTIONS = 20

/** Quote one Exec argument (Desktop Entry Spec: double quotes; escape " ` $ \ — and backslashes again for the key file). */
function quoteExecArg(a: string): string {
  const inner = a.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')
  return `"${inner.replace(/\\/g, '\\\\')}"`
}

export function execLine(args: string[]): string {
  return args.map(quoteExecArg).join(' ')
}

/** Escape a value for a desktop entry string field. */
const value = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, ' ').replace(/;/g, '\\;')
const keyword = (s: string) => value(s).trim()

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function cliScript(command: string[]): string {
  return `#!/bin/sh\nexec ${command.map(shQuote).join(' ')} "$@"\n`
}

export function windowsShortcutName(name: string): string {
  const n = name.replace(/[<>:"/\\|?*]/g, '_').trim()
  return n || 'server'
}

/** Short, stable file-name part for a server launcher. */
export const serverSlug = (id: string) => id.split('-')[0].replace(/[^A-Za-z0-9_]/g, '').slice(0, 12) || 'server'

const subtitle = (s: Server) => (s.type === 'ssh' ? `SSH ${s.username}@${s.host}${s.port !== 22 ? ':' + s.port : ''}` : 'Local shell')

export interface LinuxPlanInput {
  home: string
  /** command that starts this app (AppImage path, or electron + app dir in development) */
  command: string[]
  servers: ServersDoc
  iconSizes: number[]
  /** directory with <size>x<size>.png files */
  iconDir: string
  serverLaunchers: boolean
  cliCommand: boolean
}

export interface PlannedFile {
  path: string
  content: string
  mode?: number
}

export interface LinuxPlan {
  files: PlannedFile[]
  copies: { from: string; to: string }[]
  /** desktop file names to group in a GNOME app folder */
  appFolderApps: string[]
}

export function linuxPlan(i: LinuxPlanInput): LinuxPlan {
  const apps = join(i.home, '.local/share/applications')
  const servers = i.servers.servers.filter((s) => !(s.type === 'local' && s.hidden))
  const ssh = servers.filter((s) => s.type === 'ssh')
  const actionServers = servers.slice(0, MAX_ACTIONS)

  const main = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Prime Terminal',
    'GenericName=SSH Client',
    'Comment=SSH client with tabs, proxy jumps and port forwarding',
    `Exec=${execLine(i.command)}`,
    `Icon=${APP_ID}`,
    'Terminal=false',
    'Categories=System;TerminalEmulator;',
    `Keywords=ssh;terminal;${ssh.map((s) => keyword(s.name) + ';').join('')}`,
    `StartupWMClass=${APP_ID}`,
    `Actions=new-window;${actionServers.map((_, n) => `server-${n + 1};`).join('')}`,
    '',
    '[Desktop Action new-window]',
    'Name=New Window',
    `Exec=${execLine([...i.command, '--new-window'])}`,
    ...actionServers.flatMap((s, n) => ['', `[Desktop Action server-${n + 1}]`, `Name=${value(s.name)}`, `Exec=${execLine([...i.command, `--id=${s.id}`])}`])
  ].join('\n') + '\n'

  const files: PlannedFile[] = [{ path: join(apps, `${APP_ID}.desktop`), content: main }]
  const appFolderApps: string[] = []

  if (i.serverLaunchers) {
    for (const s of servers) {
      const file = `${APP_ID}-server-${serverSlug(s.id)}.desktop`
      const kw = s.type === 'ssh' ? ['ssh', s.host, s.username] : ['shell', 'local']
      if (s.folderId) kw.push(folderPath(s.folderId, i.servers))
      files.push({
        path: join(apps, file),
        content:
          [
            '[Desktop Entry]',
            'Type=Application',
            `Name=${value(s.name)}`,
            `GenericName=${value(subtitle(s))}`,
            `Comment=Open ${value(s.name)} in Prime Terminal`,
            `Exec=${execLine([...i.command, `--id=${s.id}`])}`,
            `Icon=${APP_ID}`,
            'Terminal=false',
            'Categories=Network;',
            `Keywords=${kw.filter(Boolean).map((k) => keyword(k) + ';').join('')}`,
            `StartupWMClass=${APP_ID}`
          ].join('\n') + '\n'
      })
      appFolderApps.push(file)
    }
  }

  if (i.cliCommand) files.push({ path: join(i.home, '.local/bin', CLI_NAME), content: cliScript(i.command), mode: 0o755 })

  const copies = i.iconSizes.map((n) => ({
    from: join(i.iconDir, `${n}x${n}.png`),
    to: join(i.home, `.local/share/icons/hicolor/${n}x${n}/apps/${APP_ID}.png`)
  }))

  return { files, copies, appFolderApps }
}
