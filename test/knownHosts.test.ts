import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { utils } from 'ssh2'
import { KnownHosts, fingerprintSha256 } from '../src/main/ssh/knownHosts'

function pubBlob(): { type: string; blob: Buffer; b64: string } {
  const kp = utils.generateKeyPairSync('ed25519')
  const [type, b64] = kp.public.split(' ')
  return { type, b64, blob: Buffer.from(b64, 'base64') }
}

const tmpFile = (content = '') => {
  const dir = mkdtempSync(join(tmpdir(), 'kh-'))
  const f = join(dir, 'known_hosts')
  writeFileSync(f, content)
  return f
}

describe('KnownHosts', () => {
  it('reports unknown for an empty or missing file', () => {
    const k = pubBlob()
    expect(new KnownHosts(join(tmpdir(), 'does-not-exist-' + Date.now())).check('h', 22, k.blob)).toBe('unknown')
  })

  it('matches plain entries including comma lists and [host]:port', () => {
    const k = pubBlob()
    const f = tmpFile(`alpha,beta ${k.type} ${k.b64}\n[gamma]:2222 ${k.type} ${k.b64}\n`)
    const kh = new KnownHosts(f)
    expect(kh.check('beta', 22, k.blob)).toBe('match')
    expect(kh.check('gamma', 2222, k.blob)).toBe('match')
    expect(kh.check('gamma', 22, k.blob)).toBe('unknown')
  })

  it('matches hashed entries', () => {
    const k = pubBlob()
    const salt = randomBytes(20)
    const hash = createHmac('sha1', salt).update('secret.example').digest()
    const f = tmpFile(`|1|${salt.toString('base64')}|${hash.toString('base64')} ${k.type} ${k.b64}\n`)
    expect(new KnownHosts(f).check('secret.example', 22, k.blob)).toBe('match')
  })

  it('reports changed when the same key type has a different key', () => {
    const a = pubBlob()
    const b = pubBlob()
    const f = tmpFile(`host ${a.type} ${a.b64}\n`)
    expect(new KnownHosts(f).check('host', 22, b.blob)).toBe('changed')
  })

  it('treats @revoked keys as changed and supports wildcards', () => {
    const k = pubBlob()
    const f = tmpFile(`@revoked * ${k.type} ${k.b64}\n*.lan ${k.type} ${k.b64}\n`)
    const kh = new KnownHosts(f)
    expect(kh.check('box.lan', 22, k.blob)).toBe('changed')
    const k2 = pubBlob()
    expect(new KnownHosts(tmpFile(`*.lan ${k2.type} ${k2.b64}\n`)).check('box.lan', 22, k2.blob)).toBe('match')
  })

  it('appends new entries and finds them afterwards', () => {
    const k = pubBlob()
    const f = tmpFile('existing ssh-ed25519 AAAA\n')
    const kh = new KnownHosts(f)
    kh.add('new.example', 2200, k.blob)
    expect(readFileSync(f, 'utf8')).toContain(`[new.example]:2200 ${k.type} ${k.b64}`)
    expect(readFileSync(f, 'utf8').startsWith('existing')).toBe(true)
    expect(new KnownHosts(f).check('new.example', 2200, k.blob)).toBe('match')
  })

  it('computes OpenSSH-style SHA256 fingerprints', () => {
    const k = pubBlob()
    expect(fingerprintSha256(k.blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })
})
