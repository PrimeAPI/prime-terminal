// Auto-detection of local shells (task.md 6).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { LocalServer, ServersDoc } from '../../shared/types'

export function parseWslList(buf: Buffer): string[] {
  // wsl.exe prints UTF-16LE (often without BOM); detect by NUL bytes
  const text = buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8')
  return text
    .replace(/^\ufeff/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trim())
    .filter(Boolean)
}

export interface DetectEnv {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  exists: (p: string) => boolean
  wslDistros: () => string[]
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Stable UUID-formatted id derived from a key, so re-detection finds the same entry. */
export function stableUuid(key: string): string {
  const h = createHash('sha1').update(key).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function auto(key: string, name: string, shell: string, args?: string[]): LocalServer {
  return { id: stableUuid(`prime-terminal:local-shell:${key}`), type: 'local', name, shell, ...(args ? { args } : {}), autoDetected: true }
}

export function detectShells(e: DetectEnv): LocalServer[] {
  if (e.platform !== 'win32') {
    const shell = e.env.SHELL || '/bin/bash'
    const name = shell.split('/').pop() || 'shell'
    return [auto('default', name, shell)]
  }
  const root = e.env.SystemRoot || 'C:\\Windows'
  const pf = e.env.ProgramFiles || 'C:\\Program Files'
  const sys32 = `${root}\\System32`
  const out: LocalServer[] = []
  const pwsh = `${pf}\\PowerShell\\7\\pwsh.exe`
  if (e.exists(pwsh)) out.push(auto('pwsh', 'PowerShell 7', pwsh, ['-NoLogo']))
  const ps = `${sys32}\\WindowsPowerShell\\v1.0\\powershell.exe`
  if (e.exists(ps)) out.push(auto('powershell', 'Windows PowerShell', ps, ['-NoLogo']))
  const cmd = `${sys32}\\cmd.exe`
  if (e.exists(cmd)) out.push(auto('cmd', 'Command Prompt', cmd))
  const gitBash = `${pf}\\Git\\bin\\bash.exe`
  if (e.exists(gitBash)) out.push(auto('git-bash', 'Git Bash', gitBash, ['--login', '-i']))
  const wsl = `${sys32}\\wsl.exe`
  if (e.exists(wsl)) {
    for (const d of e.wslDistros()) out.push(auto(`wsl-${slug(d)}`, `WSL: ${d}`, wsl, ['-d', d]))
  }
  return out
}

export function detectShellsOnThisMachine(): LocalServer[] {
  return detectShells({
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    wslDistros: () => {
      try {
        return parseWslList(execFileSync('wsl.exe', ['-l', '-q'], { timeout: 3000, windowsHide: true }))
      } catch {
        return []
      }
    }
  })
}

/** Add detected shells that are not yet in the document. Existing entries are left alone. */
export function mergeDetectedShells(doc: ServersDoc, detected: LocalServer[]): { doc: ServersDoc; changed: boolean } {
  const known = new Set(doc.servers.map((s) => s.id))
  const add = detected.filter((d) => !known.has(d.id))
  if (!add.length) return { doc, changed: false }
  return { doc: { ...doc, servers: [...doc.servers, ...add] }, changed: true }
}
