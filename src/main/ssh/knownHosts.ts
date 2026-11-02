import { createHash, createHmac } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type HostKeyStatus = 'match' | 'unknown' | 'changed'

interface Entry {
  marker: '' | '@revoked' | '@cert-authority'
  hosts: string
  keyType: string
  blob: Buffer
}

/** Key type is the first SSH string in the public key blob. */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const len = blob.readUInt32BE(0)
  return blob.subarray(4, 4 + len).toString('ascii')
}

export function fingerprintSha256(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

const hostToken = (host: string, port: number) => (port === 22 ? host : `[${host}]:${port}`)

function globMatch(pattern: string, text: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re}$`, 'i').test(text)
}

function hostsMatch(field: string, token: string): boolean {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|')
    if (!salt || !hash) return false
    const h = createHmac('sha1', Buffer.from(salt, 'base64')).update(token).digest('base64')
    return h === hash
  }
  let matched = false
  for (const p of field.split(',')) {
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), token)) return false
    } else if (globMatch(p, token)) matched = true
  }
  return matched
}

/** Reader/writer for an OpenSSH known_hosts file (re-read on every check, so external edits apply). */
export class KnownHosts {
  constructor(private readonly file: string) {}

  private entries(): Entry[] {
    if (!existsSync(this.file)) return []
    const out: Entry[] = []
    for (const raw of readFileSync(this.file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const parts = line.split(/\s+/)
      let marker: Entry['marker'] = ''
      if (parts[0] === '@revoked' || parts[0] === '@cert-authority') marker = parts.shift() as Entry['marker']
      if (parts.length < 3) continue
      let blob: Buffer
      try {
        blob = Buffer.from(parts[2], 'base64')
      } catch {
        continue
      }
      out.push({ marker, hosts: parts[0], keyType: parts[1], blob })
    }
    return out
  }

  check(host: string, port: number, blob: Buffer): HostKeyStatus {
    const token = hostToken(host, port)
    const type = keyTypeOf(blob)
    let sawSameType = false
    for (const e of this.entries()) {
      if (e.marker === '@cert-authority' || !hostsMatch(e.hosts, token)) continue
      if (e.marker === '@revoked') {
        if (e.blob.equals(blob)) return 'changed'
        continue
      }
      if (e.keyType !== type) continue
      if (e.blob.equals(blob)) return 'match'
      sawSameType = true
    }
    return sawSameType ? 'changed' : 'unknown'
  }

  add(host: string, port: number, blob: Buffer): void {
    mkdirSync(dirname(this.file), { recursive: true })
    let prefix = ''
    if (existsSync(this.file)) {
      const cur = readFileSync(this.file, 'utf8')
      if (cur.length && !cur.endsWith('\n')) prefix = '\n'
    }
    appendFileSync(this.file, `${prefix}${hostToken(host, port)} ${keyTypeOf(blob)} ${blob.toString('base64')}\n`, {
      mode: 0o600
    })
  }
}
