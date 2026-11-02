import { describe, expect, it } from 'vitest'
import { cliScript, execLine, linuxPlan, MAX_ACTIONS, windowsShortcutName } from '../src/main/desktop/entries'
import type { ServersDoc } from '../src/shared/types'

const doc: ServersDoc = {
  folders: [{ id: 'f', name: 'Prod' }],
  servers: [
    { id: '0b5c1e9a-1111-4222-8333-444455556666', type: 'ssh', name: 'web "01"', host: 'web.example.com', port: 22, username: 'deploy', folderId: 'f', auth: { method: 'auto' } },
    { id: 'aa', type: 'ssh', name: 'db', host: '10.0.0.5', port: 2222, username: 'root', auth: { method: 'auto' } },
    { id: 'l', type: 'local', name: 'bash', shell: '/bin/bash' }
  ]
}

const plan = (opts: Partial<Parameters<typeof linuxPlan>[0]> = {}) =>
  linuxPlan({
    home: '/home/me',
    command: ['/opt/apps/Prime Terminal.AppImage'],
    servers: doc,
    iconSizes: [16, 256],
    iconDir: '/res/icons',
    serverLaunchers: true,
    cliCommand: true,
    ...opts
  })

describe('desktop entry helpers', () => {
  it('quotes Exec arguments according to the desktop entry spec', () => {
    expect(execLine(['/opt/My App/app', '--id=x'])).toBe('"/opt/My App/app" "--id=x"')
    expect(execLine(['/a/b$c', 'x"y`z\\'])).toBe('"/a/b\\\\$c" "x\\\\"y\\\\`z\\\\\\\\"')
  })

  it('writes a CLI wrapper that forwards all arguments', () => {
    expect(cliScript(['/opt/x.AppImage'])).toBe("#!/bin/sh\nexec '/opt/x.AppImage' \"$@\"\n")
    expect(cliScript(["/it's/x"])).toContain("'/it'\\''s/x'")
  })

  it('makes safe Windows shortcut names', () => {
    expect(windowsShortcutName('a/b:c*?"<>|d')).toBe('a_b_c______d')
    expect(windowsShortcutName('  ')).toBe('server')
  })
})

describe('linuxPlan', () => {
  it('creates the main launcher with icon, WM class, keywords and server actions', () => {
    const main = plan().files.find((f) => f.path === '/home/me/.local/share/applications/prime-terminal.desktop')!
    expect(main.content).toContain('Name=Prime Terminal\n')
    expect(main.content).toContain('Exec="/opt/apps/Prime Terminal.AppImage"\n')
    expect(main.content).toContain('Icon=prime-terminal\n')
    expect(main.content).toContain('StartupWMClass=prime-terminal\n')
    expect(main.content).toMatch(/Keywords=ssh;terminal;.*db;/)
    expect(main.content).toContain('Actions=new-window;server-1;server-2;server-3;\n')
    expect(main.content).toContain('[Desktop Action server-2]\nName=db\nExec="/opt/apps/Prime Terminal.AppImage" "--id=aa"\n')
  })

  it('creates one searchable launcher per server and lists them for the app folder', () => {
    const p = plan()
    const web = p.files.find((f) => f.path.endsWith('prime-terminal-server-0b5c1e9a.desktop'))!
    expect(web.content).toContain('Name=web "01"\n')
    expect(web.content).toContain('GenericName=SSH deploy@web.example.com\n')
    expect(web.content).toContain('Keywords=ssh;web.example.com;deploy;Prod;\n')
    expect(web.content).toContain('Exec="/opt/apps/Prime Terminal.AppImage" "--id=0b5c1e9a-1111-4222-8333-444455556666"\n')
    expect(p.appFolderApps).toEqual(expect.arrayContaining(['prime-terminal-server-0b5c1e9a.desktop', 'prime-terminal-server-aa.desktop']))
  })

  it('installs icons and the primeterminal command', () => {
    const p = plan()
    expect(p.copies).toEqual([
      { from: '/res/icons/16x16.png', to: '/home/me/.local/share/icons/hicolor/16x16/apps/prime-terminal.png' },
      { from: '/res/icons/256x256.png', to: '/home/me/.local/share/icons/hicolor/256x256/apps/prime-terminal.png' }
    ])
    expect(p.files.find((f) => f.path === '/home/me/.local/bin/primeterminal')).toMatchObject({ mode: 0o755 })
  })

  it('leaves out server launchers and the command when disabled', () => {
    const p = plan({ serverLaunchers: false, cliCommand: false })
    expect(p.files.map((f) => f.path)).toEqual(['/home/me/.local/share/applications/prime-terminal.desktop'])
    expect(p.appFolderApps).toEqual([])
  })

  it('caps the number of right-click actions', () => {
    const many: ServersDoc = {
      folders: [],
      servers: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, type: 'ssh' as const, name: `s${i}`, host: 'h', port: 22, username: 'u', auth: { method: 'auto' as const } }))
    }
    const main = plan({ servers: many }).files[0].content
    expect(main.match(/\[Desktop Action server-/g)!.length).toBe(MAX_ACTIONS)
  })
})
