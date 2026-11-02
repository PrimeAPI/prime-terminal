import { describe, expect, it } from 'vitest'
import { detectShells, mergeDetectedShells, parseWslList } from '../src/main/shells/detect'
import type { ServersDoc } from '../src/shared/types'

describe('parseWslList', () => {
  it('decodes UTF-16LE output of `wsl -l -q` and drops empty lines', () => {
    const buf = Buffer.from('\ufeffUbuntu-22.04\r\nDebian\r\n\r\n', 'utf16le')
    expect(parseWslList(buf)).toEqual(['Ubuntu-22.04', 'Debian'])
  })
  it('also accepts UTF-8 output', () => {
    expect(parseWslList(Buffer.from('Ubuntu\nkali-linux\n'))).toEqual(['Ubuntu', 'kali-linux'])
  })
})

describe('detectShells', () => {
  it('uses $SHELL on Linux with /bin/bash fallback', () => {
    expect(detectShells({ platform: 'linux', env: { SHELL: '/usr/bin/zsh' }, exists: () => true, wslDistros: () => [] })).toEqual([
      expect.objectContaining({ id: 'local-auto-default', name: 'zsh', shell: '/usr/bin/zsh', autoDetected: true })
    ])
    expect(detectShells({ platform: 'linux', env: {}, exists: () => true, wslDistros: () => [] })[0].shell).toBe('/bin/bash')
  })

  it('finds PowerShell 7, Windows PowerShell, cmd, Git Bash and WSL distros on Windows', () => {
    const files = new Set([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Windows\\System32\\wsl.exe'
    ])
    const shells = detectShells({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      exists: (p) => files.has(p),
      wslDistros: () => ['Ubuntu']
    })
    expect(shells.map((s) => s.name)).toEqual(['PowerShell 7', 'Windows PowerShell', 'Command Prompt', 'Git Bash', 'WSL: Ubuntu'])
    expect(shells.find((s) => s.name === 'WSL: Ubuntu')).toMatchObject({ shell: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] })
    expect(shells.find((s) => s.name === 'Git Bash')!.args).toEqual(['--login', '-i'])
  })
})

describe('mergeDetectedShells', () => {
  it('adds new detected shells but keeps existing entries (including hidden flags) untouched', () => {
    const doc: ServersDoc = {
      folders: [],
      servers: [{ id: 'local-auto-default', type: 'local', name: 'bash', shell: '/bin/bash', autoDetected: true, hidden: true }]
    }
    const detected = [
      { id: 'local-auto-default', type: 'local' as const, name: 'zsh', shell: '/bin/zsh', autoDetected: true },
      { id: 'local-auto-wsl-ubuntu', type: 'local' as const, name: 'WSL: Ubuntu', shell: 'wsl.exe', autoDetected: true }
    ]
    const r = mergeDetectedShells(doc, detected)
    expect(r.changed).toBe(true)
    expect(r.doc.servers).toHaveLength(2)
    expect(r.doc.servers[0]).toMatchObject({ hidden: true, shell: '/bin/bash' })
    expect(mergeDetectedShells(r.doc, detected).changed).toBe(false)
  })
})
