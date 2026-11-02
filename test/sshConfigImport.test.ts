import { describe, expect, it } from 'vitest'
import { importSshConfig } from '../src/main/ssh/sshConfigImport'
import type { ServersDoc, SshServer } from '../src/shared/types'

const empty = (): ServersDoc => ({ folders: [], servers: [] })
const byName = (doc: ServersDoc, name: string) => doc.servers.find((s) => s.name === name) as SshServer

describe('importSshConfig', () => {
  const cfg = `
# comment
Host bastion
  HostName bastion.example.com
  User jump
  Port 2222

Host web web-alias
    HostName 10.0.0.5
    IdentityFile ~/.ssh/id_web
    ProxyJump bastion

Host db
  Hostname=db.internal
  ProxyJump admin@gw.example.com:2200,bastion

Host *.corp !skip.corp
  User corpuser

Host *
  User defaultuser
  Port 22

Match host foo
  User nope

Include ~/.ssh/conf.d/*
`

  it('creates servers for concrete hosts with first-match-wins option semantics', () => {
    const r = importSshConfig(cfg, empty(), 'me')
    const bastion = byName(r.doc, 'bastion')
    expect(bastion).toMatchObject({ host: 'bastion.example.com', username: 'jump', port: 2222, auth: { method: 'auto' } })
    const web = byName(r.doc, 'web')
    expect(web).toMatchObject({ host: '10.0.0.5', username: 'defaultuser', port: 22, auth: { method: 'key', keyPath: '~/.ssh/id_web' } })
    expect(byName(r.doc, 'web-alias')).toBeTruthy()
  })

  it('links ProxyJump to existing aliases and creates servers for ad-hoc jump specs', () => {
    const r = importSshConfig(cfg, empty(), 'me')
    const bastion = byName(r.doc, 'bastion')
    expect(byName(r.doc, 'web').proxyJump).toEqual({ enabled: true, chain: [bastion.id] })
    const db = byName(r.doc, 'db')
    const gw = r.doc.servers.find((s) => s.id === db.proxyJump!.chain[0]) as SshServer
    expect(gw).toMatchObject({ host: 'gw.example.com', port: 2200, username: 'admin' })
    expect(db.proxyJump!.chain[1]).toBe(bastion.id)
  })

  it('skips wildcard hosts, warns about Match and Include', () => {
    const r = importSshConfig(cfg, empty(), 'me')
    expect(r.doc.servers.some((s) => s.name.includes('*'))).toBe(false)
    expect(r.warnings.join('\n')).toMatch(/Match/)
    expect(r.warnings.join('\n')).toMatch(/Include/)
  })

  it('does not duplicate servers that already exist by name', () => {
    const first = importSshConfig(cfg, empty(), 'me')
    const second = importSshConfig(cfg, first.doc, 'me')
    expect(second.added).toBe(0)
    expect(second.doc.servers.length).toBe(first.doc.servers.length)
  })

  it('uses the OS user when no User is configured and ignores ProxyJump none', () => {
    const r = importSshConfig('Host solo\n  HostName solo.example\n  ProxyJump none\n', empty(), 'me')
    expect(byName(r.doc, 'solo')).toMatchObject({ username: 'me', port: 22 })
    expect(byName(r.doc, 'solo').proxyJump).toBeUndefined()
  })
})
