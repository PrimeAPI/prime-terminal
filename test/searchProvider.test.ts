import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SEARCH_BUS_NAME,
  SEARCH_OBJECT_PATH,
  searchProviderIni,
  searchProviderScript,
  userSearchProviderBase
} from '../src/main/desktop/searchProvider'

describe('search provider files', () => {
  it('points GNOME Shell at the launcher and the D-Bus name', () => {
    expect(searchProviderIni()).toBe(
      `[Shell Search Provider]\nDesktopId=prime-terminal.desktop\nBusName=${SEARCH_BUS_NAME}\nObjectPath=${SEARCH_OBJECT_PATH}\nVersion=2\n`
    )
  })

  it('picks a writable data dir inside the home directory only', () => {
    const dirs = ['/usr/share/gnome', '/home/me/.local/share/flatpak/exports/share/', '/usr/local/share/']
    expect(userSearchProviderBase(dirs, '/home/me', () => true)).toBe('/home/me/.local/share/flatpak/exports/share')
    expect(userSearchProviderBase(dirs, '/home/me', () => false)).toBeNull()
    expect(userSearchProviderBase(['/home/meow/x'], '/home/me', () => true)).toBeNull()
  })
})

const hasPythonGi = spawnSync('python3', ['-c', "import gi; gi.require_version('Gio','2.0')"]).status === 0
const hasDbus = existsSync('/usr/bin/dbus-run-session') && existsSync('/usr/bin/gdbus')

describe.skipIf(!hasPythonGi || !hasDbus || process.platform !== 'linux')('search provider over D-Bus', () => {
  it('returns matching servers with metadata and launches the app on activation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-'))
    const servers = join(dir, 'servers.json')
    writeFileSync(
      servers,
      JSON.stringify({
        folders: [
          { id: 'p', name: 'Production' },
          { id: 'w', name: 'Web', parentId: 'p' }
        ],
        servers: [
          { id: 's1', type: 'ssh', name: 'web-01', host: 'web01.example.com', port: 22, username: 'deploy', folderId: 'w', auth: { method: 'auto' } },
          { id: 's2', type: 'ssh', name: 'db', host: '10.0.0.5', port: 2222, username: 'root', auth: { method: 'auto' } },
          { id: 'l1', type: 'local', name: 'hidden-shell', shell: '/bin/sh', hidden: true }
        ]
      })
    )
    const out = join(dir, 'launched.txt')
    const launcher = join(dir, 'launch.sh')
    writeFileSync(launcher, `#!/bin/sh\necho "$@" >> ${out}\n`, { mode: 0o755 })
    const script = join(dir, 'provider.py')
    writeFileSync(script, searchProviderScript({ serversFile: servers, command: [launcher] }))

    // talk to the provider on a private session bus
    const call = (method: string, ...args: string[]) =>
      `gdbus call --session --dest ${SEARCH_BUS_NAME} --object-path ${SEARCH_OBJECT_PATH} --method org.gnome.Shell.SearchProvider2.${method} ${args.map((a) => `"${a}"`).join(' ')}`
    const session = [
      `python3 ${script} &`,
      'for i in $(seq 50); do gdbus introspect --session --dest ' + SEARCH_BUS_NAME + ' --object-path ' + SEARCH_OBJECT_PATH + ' >/dev/null 2>&1 && break; sleep 0.1; done',
      call('GetInitialResultSet', "['web']"),
      call('GetInitialResultSet', "['production', 'deploy']"),
      call('GetInitialResultSet', "['10.0.0']"),
      call('GetInitialResultSet', "['hidden']"),
      call('GetSubsearchResultSet', "['s1']", "['web-0']"),
      call('GetResultMetas', "['s1']"),
      call('ActivateResult', 's2', "['db']", '0'),
      call('LaunchSearch', "['some', 'host']", '0'),
      'sleep 0.5'
    ].join('\n')
    const stdout = execFileSync('dbus-run-session', ['--', 'sh', '-c', session], { encoding: 'utf8', timeout: 20000 })
    const lines = stdout.trim().split('\n')
    expect(lines[0]).toBe("(['s1'],)")
    expect(lines[1]).toBe("(['s1'],)")
    expect(lines[2]).toBe("(['s2'],)")
    expect(lines[3]).toBe('(@as [],)')
    expect(lines[4]).toBe("(['s1'],)")
    expect(lines[5]).toContain("'name': <'web-01'>")
    expect(lines[5]).toContain("'description': <'Production / Web  ·  deploy@web01.example.com'>")
    expect(lines[5]).toContain("'gicon': <'prime-terminal'>")
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual(['--id=s2', 'some host'])
  })
})
