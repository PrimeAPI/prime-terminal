// Connects to the last server of a hop list, tunnelling through the preceding hops (ProxyJump).

import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import type { ConnectConfig } from 'ssh2'
import { Client } from './ssh2'
import type { PromptRequest, SshServer } from '../../shared/types'
import { buildAttempts, makeAuthHandler, type AuthHandlerState } from './auth'
import { fingerprintSha256, keyTypeOf, type KnownHosts } from './knownHosts'

type HostKeyPrompt = Extract<PromptRequest, { kind: 'hostKey' }>
type SecretPrompt = Extract<PromptRequest, { kind: 'secret' }>
type KbdPrompt = Extract<PromptRequest, { kind: 'keyboardInteractive' }>

export interface Prompter {
  hostKey(req: HostKeyPrompt): Promise<boolean>
  secret(req: SecretPrompt): Promise<{ value: string; save: boolean } | null>
  keyboardInteractive(req: KbdPrompt): Promise<string[] | null>
}

export interface ConnectDeps {
  knownHosts: KnownHosts
  prompter: Prompter
  /** seconds */
  keepaliveInterval: number
  /** seconds */
  readyTimeout: number
  homeDir: string
  /** ssh-agent socket/pipe or "pageant"; null = no agent */
  agentPath: string | null
  onSecretSaved?: (serverId: string, field: 'password' | 'keyPassphrase', value: string) => void
}

/** An established (possibly multi-hop) SSH connection. Emits 'close' exactly once. */
export class SshConnection extends EventEmitter {
  private closed = false
  constructor(
    readonly client: Client,
    private readonly clients: Client[]
  ) {
    super()
    for (const c of clients) {
      c.on('close', () => this.finish())
      c.on('error', (err) => {
        this.lastError = err
      })
    }
  }

  lastError: Error | null = null

  get isClosed(): boolean {
    return this.closed
  }

  private finish() {
    if (this.closed) return
    this.closed = true
    for (const c of [...this.clients].reverse()) c.end()
    this.emit('close', this.lastError)
  }

  close(): void {
    this.finish()
  }
}

function hopLabel(s: SshServer) {
  return `${s.username}@${s.host}:${s.port}`
}

function connectHop(server: SshServer, deps: ConnectDeps, sock?: Duplex): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const state: AuthHandlerState = { cancelled: false, current: null }
    let failure: Error | null = null
    let settled = false
    const fail = (e: Error) => {
      if (settled) return
      settled = true
      client.end()
      reject(e)
    }

    const attempts = buildAttempts(server, { prompter: deps.prompter, homeDir: deps.homeDir, agentPath: deps.agentPath }, state)
    const authHandler = makeAuthHandler(server.username, attempts, state, (e) => {
      failure = e
    })

    const hostVerifier = (key: Buffer, verify: (ok: boolean) => void) => {
      const status = deps.knownHosts.check(server.host, server.port, key)
      if (status === 'match') return verify(true)
      deps.prompter
        .hostKey({
          kind: 'hostKey',
          status,
          host: server.host,
          port: server.port,
          keyType: keyTypeOf(key),
          fingerprint: fingerprintSha256(key)
        })
        .then((trust) => {
          if (status === 'changed') {
            failure = new Error(
              `Host key for ${server.host}:${server.port} has CHANGED – connection blocked. ` +
                'Remove the old key from ~/.ssh/known_hosts if the change is expected.'
            )
            return verify(false)
          }
          if (!trust) {
            failure = new Error(`Host key for ${server.host}:${server.port} not trusted`)
            return verify(false)
          }
          try {
            deps.knownHosts.add(server.host, server.port, key)
          } catch {
            // trusting still works for this session even if known_hosts is not writable
          }
          verify(true)
        })
        .catch(() => verify(false))
      return undefined
    }

    const cfg: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      sock: sock as ConnectConfig['sock'],
      authHandler: authHandler as unknown as ConnectConfig['authHandler'],
      hostVerifier: hostVerifier as unknown as ConnectConfig['hostVerifier'],
      tryKeyboard: true,
      keepaliveInterval: deps.keepaliveInterval * 1000,
      keepaliveCountMax: 3,
      readyTimeout: deps.readyTimeout * 1000
    }

    client.once('ready', () => {
      settled = true
      const save = state.current?.save
      if (save && deps.onSecretSaved) deps.onSecretSaved(server.id, save.field, save.value)
      resolve(client)
    })
    client.on('error', (err: Error & { level?: string }) => {
      if (settled) return
      if (failure) return fail(failure)
      if (err.level === 'client-authentication') {
        return fail(new Error(`Authentication failed for ${hopLabel(server)}`))
      }
      fail(new Error(`${hopLabel(server)}: ${err.message}`))
    })
    client.once('close', () => {
      if (!settled) fail(failure ?? new Error(`${hopLabel(server)}: connection closed during handshake`))
    })
    try {
      client.connect(cfg)
    } catch (e) {
      fail(e as Error)
    }
  })
}

function forwardThrough(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) reject(new Error(`Jump to ${host}:${port} failed: ${err.message}`))
      else resolve(stream)
    })
  })
}

export async function connectChain(hops: SshServer[], deps: ConnectDeps): Promise<SshConnection> {
  if (hops.length === 0) throw new Error('No server to connect to')
  const clients: Client[] = []
  try {
    let sock: Duplex | undefined
    for (let i = 0; i < hops.length; i++) {
      if (i > 0) sock = await forwardThrough(clients[i - 1], hops[i].host, hops[i].port)
      clients.push(await connectHop(hops[i], deps, sock))
    }
  } catch (e) {
    for (const c of clients.reverse()) c.end()
    throw e
  }
  return new SshConnection(clients[clients.length - 1], clients)
}
