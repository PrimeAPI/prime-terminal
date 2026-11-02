import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { applyBackup, createBackup, inspectBackup, readBackup, type BackupContents } from '../src/main/config/backup'
import { defaultSettings } from '../src/shared/defaults'

const contents = (): BackupContents => ({
  servers: {
    folders: [{ id: 'f1', name: 'Prod' }],
    servers: [
      { id: 's1', type: 'ssh', name: 'web', host: 'w', port: 22, username: 'u', folderId: 'f1', auth: { method: 'password', password: 'hunter2' } },
      { id: 's2', type: 'ssh', name: 'db', host: 'd', port: 22, username: 'u', auth: { method: 'key', keyPath: '~/.ssh/k', keyPassphrase: 'pp' } },
      { id: 'l1', type: 'local', name: 'bash', shell: '/bin/bash' }
    ]
  },
  sets: { sets: [{ id: 'set1', name: 'App', server: 's1', forwards: [{ id: 'e1', type: 'dynamic', enabled: true, bindPort: 1080 }] }] },
  settings: { ...defaultSettings(), terminal: { ...defaultSettings().terminal, fontSize: 17 } }
})

describe('backup archive', () => {
  it('is a plain zip with readable config files and no secrets when exported without password', () => {
    const zip = createBackup(contents())
    const files = unzipSync(zip)
    expect(Object.keys(files).sort()).toEqual(['forward-sets.json', 'manifest.json', 'servers.json', 'settings.json'])
    const servers = strFromU8(files['servers.json'])
    expect(servers).not.toContain('hunter2')
    expect(servers).not.toContain('"pp"')
    expect(JSON.parse(servers).servers[1].auth.keyPath).toBe('~/.ssh/k')
    expect(inspectBackup(zip)).toMatchObject({ hasSecrets: false, counts: { servers: 3, folders: 1, sets: 1 } })
  })

  it('stores secrets encrypted when a password is given and restores them with it', () => {
    const zip = createBackup(contents(), 'correct horse')
    const files = unzipSync(zip)
    expect(Object.keys(files)).toContain('secrets.enc')
    expect(strFromU8(files['secrets.enc'])).not.toContain('hunter2')
    expect(strFromU8(files['servers.json'])).not.toContain('hunter2')
    expect(inspectBackup(zip).hasSecrets).toBe(true)

    const restored = readBackup(zip, 'correct horse')
    expect(restored.servers.servers[0]).toMatchObject({ auth: { password: 'hunter2' } })
    expect(restored.servers.servers[1]).toMatchObject({ auth: { keyPassphrase: 'pp' } })
    expect(restored.settings.terminal.fontSize).toBe(17)
  })

  it('rejects a wrong password but can be read without secrets', () => {
    const zip = createBackup(contents(), 'pw')
    expect(() => readBackup(zip, 'nope')).toThrow(/wrong password/i)
    const noSecrets = readBackup(zip)
    expect(noSecrets.servers.servers[0].type === 'ssh' && noSecrets.servers.servers[0].auth.password).toBeFalsy()
  })

  it('rejects files that are not backups', () => {
    expect(() => inspectBackup(new Uint8Array([1, 2, 3]))).toThrow(/not a Prime Terminal backup/i)
  })

  it('rejects backups with invalid config files', () => {
    const zip = createBackup({ ...contents(), sets: { sets: [{ id: 'x' }] } as never })
    expect(() => readBackup(zip)).toThrow(/forward-sets.json/)
  })
})

describe('applyBackup', () => {
  const local = (): BackupContents => ({
    servers: {
      folders: [{ id: 'f-local', name: 'Mine' }],
      servers: [
        { id: 's1', type: 'ssh', name: 'web-old', host: 'old', port: 22, username: 'u', auth: { method: 'password', password: 'local-secret' } },
        { id: 'mine', type: 'ssh', name: 'mine', host: 'm', port: 22, username: 'u', auth: { method: 'auto' } }
      ]
    },
    sets: { sets: [{ id: 'local-set', name: 'Local', server: 'mine', forwards: [] }] },
    settings: defaultSettings()
  })

  it('replace mode takes everything from the backup', () => {
    const r = applyBackup(local(), readBackup(createBackup(contents())), 'replace')
    expect(r.servers.servers.map((s) => s.id)).toEqual(['s1', 's2', 'l1'])
    expect(r.sets.sets.map((s) => s.id)).toEqual(['set1'])
    expect(r.settings.terminal.fontSize).toBe(17)
  })

  it('merge mode updates by id, adds new items, keeps local ones, settings and local secrets', () => {
    const r = applyBackup(local(), readBackup(createBackup(contents())), 'merge')
    expect(r.servers.servers.map((s) => s.id)).toEqual(['s1', 'mine', 's2', 'l1'])
    const web = r.servers.servers[0]
    expect(web).toMatchObject({ name: 'web', host: 'w', auth: { password: 'local-secret' } })
    expect(r.servers.folders.map((f) => f.id)).toEqual(['f-local', 'f1'])
    expect(r.sets.sets.map((s) => s.id)).toEqual(['local-set', 'set1'])
    expect(r.settings.terminal.fontSize).toBe(defaultSettings().terminal.fontSize)
  })

  it('merge mode prefers secrets from the backup when it has them', () => {
    const r = applyBackup(local(), readBackup(createBackup(contents(), 'pw'), 'pw'), 'merge')
    expect(r.servers.servers[0]).toMatchObject({ auth: { password: 'hunter2' } })
  })
})
