// Whole-configuration backup: a plain ZIP (extension .ptbackup) with the three config files and a
// manifest. Passwords/passphrases are never stored in the readable files; with an export password
// they go into secrets.enc (AES-256-GCM, key derived with scrypt).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ForwardSetsDoc, ServersDoc, Settings, SshAuth } from '../../shared/types'
import { normalizeSettings, validateServersDoc, validateSetsDoc, validateSettingsDoc } from './configStores'

export const BACKUP_EXTENSION = 'ptbackup'
const FORMAT = 'prime-terminal-backup'
const VERSION = 1

export interface BackupContents {
  servers: ServersDoc
  sets: ForwardSetsDoc
  settings: Settings
}

export interface BackupInfo {
  createdAt: string
  hasSecrets: boolean
  counts: { servers: number; folders: number; sets: number }
}

type Secrets = Record<string, Pick<SshAuth, 'password' | 'keyPassphrase'>>

interface EncryptedBlob {
  v: 1
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
  iv: string
  tag: string
  data: string
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1 }

function deriveKey(password: string, salt: Buffer, params = SCRYPT): Buffer {
  return scryptSync(password, salt, 32, { ...params, maxmem: 128 * params.N * params.r * 2 })
}

function encrypt(plain: string, password: string): EncryptedBlob {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { v: 1, kdf: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function decrypt(blob: EncryptedBlob, password: string): string {
  const key = deriveKey(password, Buffer.from(blob.salt, 'base64'), { N: blob.N, r: blob.r, p: blob.p })
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'))
  d.setAuthTag(Buffer.from(blob.tag, 'base64'))
  try {
    return Buffer.concat([d.update(Buffer.from(blob.data, 'base64')), d.final()]).toString('utf8')
  } catch {
    throw new Error('Wrong password for the stored secrets')
  }
}

function stripSecrets(doc: ServersDoc): { doc: ServersDoc; secrets: Secrets } {
  const secrets: Secrets = {}
  const servers = doc.servers.map((s) => {
    if (s.type !== 'ssh' || (!s.auth.password && !s.auth.keyPassphrase)) return s
    const { password, keyPassphrase, ...auth } = s.auth
    secrets[s.id] = { ...(password ? { password } : {}), ...(keyPassphrase ? { keyPassphrase } : {}) }
    return { ...s, auth }
  })
  return { doc: { ...doc, servers }, secrets }
}

function addSecrets(doc: ServersDoc, secrets: Secrets): ServersDoc {
  return {
    ...doc,
    servers: doc.servers.map((s) => (s.type === 'ssh' && secrets[s.id] ? { ...s, auth: { ...s.auth, ...secrets[s.id] } } : s))
  }
}

const json = (v: unknown) => strToU8(JSON.stringify(v, null, 2) + '\n')

export function createBackup(c: BackupContents, password?: string, now = new Date()): Uint8Array {
  const { doc, secrets } = stripSecrets(c.servers)
  const withSecrets = !!password && Object.keys(secrets).length > 0
  const files: Record<string, Uint8Array> = {
    'manifest.json': json({
      format: FORMAT,
      version: VERSION,
      createdAt: now.toISOString(),
      hasSecrets: withSecrets,
      counts: { servers: c.servers.servers.length, folders: c.servers.folders.length, sets: c.sets.sets.length }
    }),
    'servers.json': json(doc),
    'forward-sets.json': json(c.sets),
    'settings.json': json(c.settings)
  }
  if (withSecrets) files['secrets.enc'] = json(encrypt(JSON.stringify(secrets), password!))
  return zipSync(files, { level: 6 })
}

function open(data: Uint8Array): { files: Record<string, Uint8Array>; manifest: BackupInfo & { format: string; version: number } } {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(data)
  } catch {
    throw new Error('This file is not a Prime Terminal backup')
  }
  const raw = files['manifest.json']
  let manifest: (BackupInfo & { format: string; version: number }) | null
  try {
    manifest = raw ? JSON.parse(strFromU8(raw)) : null
  } catch {
    manifest = null
  }
  if (!manifest || manifest.format !== FORMAT) throw new Error('This file is not a Prime Terminal backup')
  if (manifest.version > VERSION) throw new Error('This backup was created by a newer version of Prime Terminal')
  return { files, manifest }
}

export function inspectBackup(data: Uint8Array): BackupInfo {
  const { manifest, files } = open(data)
  return { createdAt: manifest.createdAt, hasSecrets: !!files['secrets.enc'], counts: manifest.counts }
}

function parseFile(files: Record<string, Uint8Array>, name: string, validate: (v: unknown) => string | null): unknown {
  const raw = files[name]
  if (!raw) throw new Error(`Backup is missing ${name}`)
  let v: unknown
  try {
    v = JSON.parse(strFromU8(raw))
  } catch (e) {
    throw new Error(`${name} in the backup is not valid JSON: ${(e as Error).message}`, { cause: e })
  }
  const problem = validate(v)
  if (problem) throw new Error(`${name} in the backup is invalid: ${problem}`)
  return v
}

/** Read and validate a backup. Without password, stored secrets are skipped. */
export function readBackup(data: Uint8Array, password?: string): BackupContents {
  const { files } = open(data)
  let servers = parseFile(files, 'servers.json', validateServersDoc) as ServersDoc
  const sets = parseFile(files, 'forward-sets.json', validateSetsDoc) as ForwardSetsDoc
  const settings = normalizeSettings(parseFile(files, 'settings.json', validateSettingsDoc))
  if (password && files['secrets.enc']) {
    const blob = JSON.parse(strFromU8(files['secrets.enc'])) as EncryptedBlob
    servers = addSecrets(servers, JSON.parse(decrypt(blob, password)) as Secrets)
  }
  return { servers, sets, settings }
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[], combine: (cur: T, inc: T) => T = (_c, i) => i): T[] {
  const inc = new Map(incoming.map((x) => [x.id, x]))
  const out = current.map((c) => (inc.has(c.id) ? combine(c, inc.get(c.id)!) : c))
  const known = new Set(current.map((c) => c.id))
  return [...out, ...incoming.filter((x) => !known.has(x.id))]
}

/**
 * replace: the backup becomes the configuration.
 * merge: folders/servers/sets are updated by id or added; local items and local settings stay;
 *        local secrets are kept unless the backup brings its own.
 */
export function applyBackup(current: BackupContents, incoming: BackupContents, mode: 'merge' | 'replace'): BackupContents {
  if (mode === 'replace') return incoming
  return {
    servers: {
      folders: mergeById(current.servers.folders, incoming.servers.folders),
      servers: mergeById(current.servers.servers, incoming.servers.servers, (cur, inc) => {
        if (cur.type !== 'ssh' || inc.type !== 'ssh') return inc
        return {
          ...inc,
          auth: {
            ...inc.auth,
            ...(inc.auth.password ? {} : cur.auth.password ? { password: cur.auth.password } : {}),
            ...(inc.auth.keyPassphrase ? {} : cur.auth.keyPassphrase ? { keyPassphrase: cur.auth.keyPassphrase } : {})
          }
        }
      })
    },
    sets: { sets: mergeById(current.sets.sets, incoming.sets.sets) },
    settings: current.settings
  }
}
