import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalPtyBackend, SshShellBackend } from '../src/main/sessions/backends'
import { connectChain } from '../src/main/ssh/connect'
import { KnownHosts } from '../src/main/ssh/knownHosts'
import { startTestServer, type TestServer } from './helpers/sshServer'

const servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

function collect(b: NodeJS.EventEmitter, until: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('timeout, got: ' + JSON.stringify(buf))), 8000)
    b.on('data', (d: string) => {
      buf += d
      if (buf.includes(until)) {
        clearTimeout(t)
        resolve(buf)
      }
    })
  })
}

describe('SshShellBackend', () => {
  it('opens a PTY shell, echoes UTF-8 input and reports exit', async () => {
    const s = await startTestServer({ password: 'pw' })
    servers.push(s)
    const b = new SshShellBackend(
      () => [{ id: 't', type: 'ssh', name: 't', host: '127.0.0.1', port: s.port, username: 'tester', auth: { method: 'password', password: 'pw' } }],
      (hops) =>
        connectChain(hops, {
          knownHosts: new KnownHosts(join(mkdtempSync(join(tmpdir(), 'kh-')), 'kh')),
          prompter: { hostKey: async () => true, secret: async () => null, keyboardInteractive: async () => null },
          keepaliveInterval: 30,
          readyTimeout: 5,
          homeDir: tmpdir(),
          agentPaths: []
        })
    )
    const got = collect(b, 'grüße')
    await b.start(80, 24)
    b.write('grüße')
    expect(await got).toContain('welcome')
    const exited = new Promise((r) => b.once('exit', r))
    b.write('\x04')
    await exited
  })
})

describe.skipIf(process.platform === 'win32')('LocalPtyBackend', () => {
  it('spawns a local shell in a PTY', async () => {
    const b = new LocalPtyBackend({ id: 'l', type: 'local', name: 'sh', shell: '/bin/sh', args: ['-c', 'echo pty-ok; sleep 0.2'] })
    const got = collect(b, 'pty-ok')
    const exited = new Promise<string>((r) => b.once('exit', r))
    await b.start(80, 24)
    expect(await got).toContain('pty-ok')
    expect(await exited).toMatch(/code 0/)
  })
})
