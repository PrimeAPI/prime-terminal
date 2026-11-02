import { describe, expect, it } from 'vitest'
import { parseLaunchArgs, resolveLaunchTarget } from '../src/shared/launch'
import type { ServersDoc } from '../src/shared/types'

const doc: ServersDoc = {
  folders: [],
  servers: [
    { id: 'id-web', type: 'ssh', name: 'Web-01', host: 'web01.example.com', port: 22, username: 'deploy', auth: { method: 'auto' } },
    { id: 'id-db', type: 'ssh', name: 'db', host: '10.0.0.5', port: 2222, username: 'root', auth: { method: 'auto' } },
    { id: 'id-dup1', type: 'ssh', name: 'dup', host: 'a', port: 22, username: 'u', auth: { method: 'auto' } },
    { id: 'id-dup2', type: 'ssh', name: 'dup', host: 'b', port: 22, username: 'u', auth: { method: 'auto' } },
    { id: 'id-local', type: 'local', name: 'bash', shell: '/bin/bash' }
  ]
}

describe('parseLaunchArgs', () => {
  it('collects targets and ignores Chromium/Electron switches', () => {
    expect(parseLaunchArgs(['web-01', '--enable-logging', 'db', '--no-sandbox'])).toEqual({ targets: ['web-01', 'db'], newWindow: false, help: false })
  })
  it('understands --id, --new-window and --help', () => {
    expect(parseLaunchArgs(['--new-window', '--id=id-web'])).toEqual({ targets: ['--id=id-web'], newWindow: true, help: false })
    expect(parseLaunchArgs(['-h']).help).toBe(true)
    expect(parseLaunchArgs(['--help']).help).toBe(true)
  })
  it('ignores the app path Electron passes in development and empty args', () => {
    expect(parseLaunchArgs(['', 'web'])).toEqual({ targets: ['web'], newWindow: false, help: false })
  })
})

describe('resolveLaunchTarget', () => {
  it('matches saved servers by name (case-insensitive) and by id', () => {
    expect(resolveLaunchTarget('web-01', doc)).toEqual({ kind: 'server', serverId: 'id-web' })
    expect(resolveLaunchTarget('--id=id-db', doc)).toEqual({ kind: 'server', serverId: 'id-db' })
    expect(resolveLaunchTarget('bash', doc)).toEqual({ kind: 'server', serverId: 'id-local' })
  })

  it('matches saved servers by host, user@host and host:port', () => {
    expect(resolveLaunchTarget('web01.example.com', doc)).toEqual({ kind: 'server', serverId: 'id-web' })
    expect(resolveLaunchTarget('root@10.0.0.5:2222', doc)).toEqual({ kind: 'server', serverId: 'id-db' })
    expect(resolveLaunchTarget('10.0.0.5', doc)).toEqual({ kind: 'server', serverId: 'id-db' })
  })

  it('connects ad hoc to unknown hosts like ssh would', () => {
    expect(resolveLaunchTarget('admin@new.example.com:2200', doc)).toEqual({
      kind: 'adhoc',
      target: { username: 'admin', host: 'new.example.com', port: 2200 }
    })
    // different user than the saved one → ad hoc, not the saved server
    expect(resolveLaunchTarget('other@web01.example.com', doc)).toMatchObject({ kind: 'adhoc' })
  })

  it('reports ambiguous names and things that are neither servers nor hosts', () => {
    expect(resolveLaunchTarget('dup', doc)).toEqual({ kind: 'ambiguous', query: 'dup' })
    expect(resolveLaunchTarget('--id=missing', doc)).toEqual({ kind: 'notFound', query: '--id=missing' })
    expect(resolveLaunchTarget('my server', doc)).toEqual({ kind: 'notFound', query: 'my server' })
  })
})
