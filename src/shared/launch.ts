// Command line: `primeterminal [--new-window] <server name | host | user@host[:port] | --id=<id>> ...`

import { parseAdhocTarget, type AdhocTarget } from './fuzzy'
import type { ServersDoc } from './types'

export interface LaunchArgs {
  targets: string[]
  newWindow: boolean
  help: boolean
}

export const USAGE = `Usage: primeterminal [--new-window] [target ...]

  target   name of a saved server, its host name, user@host[:port],
           or any other host to connect to ad hoc

Examples:
  primeterminal web-01
  primeterminal deploy@10.0.0.5:2222
  primeterminal --new-window db-1 db-2
`

/** `args` are the user arguments (without executable / app path). */
export function parseLaunchArgs(args: string[]): LaunchArgs {
  const out: LaunchArgs = { targets: [], newWindow: false, help: false }
  for (const a of args) {
    if (!a) continue
    if (a === '-h' || a === '--help') out.help = true
    else if (a === '--new-window') out.newWindow = true
    else if (a.startsWith('--id=')) out.targets.push(a)
    else if (a.startsWith('-')) continue // Chromium / Electron switches
    else out.targets.push(a)
  }
  return out
}

export type LaunchTarget =
  | { kind: 'server'; serverId: string }
  | { kind: 'adhoc'; target: AdhocTarget }
  | { kind: 'ambiguous'; query: string }
  | { kind: 'notFound'; query: string }

export function resolveLaunchTarget(arg: string, doc: ServersDoc): LaunchTarget {
  if (arg.startsWith('--id=')) {
    const id = arg.slice(5)
    return doc.servers.some((s) => s.id === id) ? { kind: 'server', serverId: id } : { kind: 'notFound', query: arg }
  }
  const q = arg.trim()
  const byName = doc.servers.filter((s) => s.name.toLowerCase() === q.toLowerCase())
  if (byName.length === 1) return { kind: 'server', serverId: byName[0].id }
  if (byName.length > 1) return { kind: 'ambiguous', query: q }

  const adhoc = parseAdhocTarget(q)
  if (!adhoc) return { kind: 'notFound', query: q }
  const byHost = doc.servers.filter(
    (s) =>
      s.type === 'ssh' &&
      s.host.toLowerCase() === adhoc.host.toLowerCase() &&
      (adhoc.username === undefined || adhoc.username === s.username) &&
      (adhoc.port === undefined || adhoc.port === s.port)
  )
  if (byHost.length === 1) return { kind: 'server', serverId: byHost[0].id }
  if (byHost.length > 1) return { kind: 'ambiguous', query: q }
  return { kind: 'adhoc', target: adhoc }
}
