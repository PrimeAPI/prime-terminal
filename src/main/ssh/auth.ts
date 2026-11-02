// Builds the ordered list of authentication attempts for one server and adapts it to
// ssh2's `authHandler` callback API.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { utils } from './ssh2'
import type { SshServer } from '../../shared/types'
import type { Prompter } from './connect'

type AuthConfig =
  | { type: 'password'; username: string; password: string }
  | { type: 'publickey'; username: string; key: Buffer; passphrase?: string }
  | { type: 'agent'; username: string; agent: string }
  | {
      type: 'keyboard-interactive'
      username: string
      prompt: (name: string, instructions: string, lang: string, prompts: { prompt: string; echo: boolean }[], finish: (answers: string[]) => void) => void
    }

type MethodName = AuthConfig['type']

interface Attempt {
  method: MethodName
  /** Returns the auth config, `null` to skip, or throws AuthCancelled. */
  run: () => Promise<AuthConfig | null>
  /** Secret to persist once this attempt led to a successful login. */
  save?: { field: 'password' | 'keyPassphrase'; value: string }
}

export class AuthCancelled extends Error {
  constructor() {
    super('Authentication cancelled')
  }
}

export interface AuthContext {
  prompter: Prompter
  homeDir: string
  agentPath: string | null
}

export const DEFAULT_KEY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa']
const MAX_PROMPTS = 3

export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2))
  return p
}

function isEncryptedKeyError(e: Error): boolean {
  return /passphrase|encrypted/i.test(e.message)
}

function keyAttempts(
  server: SshServer,
  ctx: AuthContext,
  files: string[],
  promptForPassphrase: boolean
): Attempt[] {
  const user = server.username
  const out: Attempt[] = []
  for (const file of files) {
    if (!existsSync(file)) continue
    let data: Buffer
    try {
      data = readFileSync(file)
    } catch {
      continue
    }
    const parsed = utils.parseKey(data)
    if (!(parsed instanceof Error)) {
      out.push({ method: 'publickey', run: async () => ({ type: 'publickey', username: user, key: data }) })
      continue
    }
    if (!isEncryptedKeyError(parsed)) continue
    const stored = server.auth.keyPassphrase
    if (stored) {
      out.push({
        method: 'publickey',
        run: async () => (utils.parseKey(data, stored) instanceof Error ? null : { type: 'publickey', username: user, key: data, passphrase: stored })
      })
    }
    if (!promptForPassphrase) continue
    const attempt: Attempt = {
      method: 'publickey',
      run: async () => {
        for (let i = 0; i < MAX_PROMPTS; i++) {
          const r = await ctx.prompter.secret({
            kind: 'secret',
            secret: 'passphrase',
            serverName: server.name,
            message: i === 0 ? `Passphrase for key ${file}` : `Wrong passphrase. Passphrase for key ${file}`,
            allowSave: true
          })
          if (!r) throw new AuthCancelled()
          if (!(utils.parseKey(data, r.value) instanceof Error)) {
            attempt.save = r.save ? { field: 'keyPassphrase', value: r.value } : undefined
            return { type: 'publickey', username: user, key: data, passphrase: r.value }
          }
        }
        return null
      }
    }
    out.push(attempt)
  }
  return out
}

function storedPasswordAttempt(server: SshServer): Attempt[] {
  const pw = server.auth.password
  return pw ? [{ method: 'password', run: async () => ({ type: 'password', username: server.username, password: pw }) }] : []
}

function promptedPasswordAttempts(server: SshServer, ctx: AuthContext): Attempt[] {
  const user = server.username
  const out: Attempt[] = []
  for (let i = 0; i < MAX_PROMPTS; i++) {
    const attempt: Attempt = {
      method: 'password',
      run: async () => {
        const r = await ctx.prompter.secret({
          kind: 'secret',
          secret: 'password',
          serverName: server.name,
          message:
            i === 0 && !server.auth.password
              ? `Password for ${user}@${server.host}`
              : `Permission denied, please try again. Password for ${user}@${server.host}`,
          allowSave: true
        })
        if (!r) throw new AuthCancelled()
        attempt.save = r.save ? { field: 'password', value: r.value } : undefined
        return { type: 'password', username: user, password: r.value }
      }
    }
    out.push(attempt)
  }
  return out
}

function keyboardInteractiveAttempt(server: SshServer, ctx: AuthContext, onCancel: () => void): Attempt {
  let usedStored = false
  return {
    method: 'keyboard-interactive',
    run: async () => ({
      type: 'keyboard-interactive',
      username: server.username,
      prompt: (name, instructions, _lang, prompts, finish) => {
        // PAM password prompts: answer with the stored password once instead of asking.
        const pw = server.auth.password
        if (pw && !usedStored && prompts.length === 1 && /password/i.test(prompts[0].prompt)) {
          usedStored = true
          return finish([pw])
        }
        ctx.prompter
          .keyboardInteractive({ kind: 'keyboardInteractive', serverName: server.name, name, instructions, prompts })
          .then((answers) => {
            if (!answers) {
              onCancel()
              finish([])
            } else finish(answers)
          })
          .catch(() => finish([]))
      }
    })
  }
}

export interface AuthHandlerState {
  cancelled: boolean
  /** The attempt that was in flight when authentication succeeded. */
  current: Attempt | null
}

export function buildAttempts(server: SshServer, ctx: AuthContext, state: AuthHandlerState): Attempt[] {
  const auth = server.auth
  const onCancel = () => {
    state.cancelled = true
  }
  const agent: Attempt[] = ctx.agentPath
    ? [{ method: 'agent', run: async () => ({ type: 'agent', username: server.username, agent: ctx.agentPath! }) }]
    : []
  const defaultKeyFiles = DEFAULT_KEY_FILES.map((f) => join(ctx.homeDir, '.ssh', f))
  const explicitKey = auth.keyPath ? [expandHome(auth.keyPath, ctx.homeDir)] : null

  switch (auth.method) {
    case 'agent':
      return agent
    case 'key':
      return keyAttempts(server, ctx, explicitKey ?? defaultKeyFiles, true)
    case 'password':
      return [
        ...storedPasswordAttempt(server),
        keyboardInteractiveAttempt(server, ctx, onCancel),
        ...promptedPasswordAttempts(server, ctx)
      ]
    case 'auto':
    default:
      return [
        ...agent,
        ...keyAttempts(server, ctx, explicitKey ?? defaultKeyFiles, !!explicitKey),
        ...storedPasswordAttempt(server),
        keyboardInteractiveAttempt(server, ctx, onCancel),
        ...promptedPasswordAttempts(server, ctx)
      ]
  }
}

type NextAuth = (auth: AuthConfig | false) => void

/** ssh2 authHandler that walks the attempts, honouring the server's allowed methods. */
export function makeAuthHandler(
  username: string,
  attempts: Attempt[],
  state: AuthHandlerState,
  onError: (e: Error) => void
) {
  let i = 0
  let kbdTries = 0
  let sentNone = false
  return (methodsLeft: string[] | null, _partial: boolean | null, next: NextAuth) => {
    const step = async (): Promise<void> => {
      if (state.cancelled) return next(false)
      if (!methodsLeft && !sentNone) {
        // probe with "none" to learn which methods the server accepts
        sentNone = true
        return next({ type: 'none', username } as never)
      }
      while (i < attempts.length) {
        const a = attempts[i++]
        if (methodsLeft && !methodsLeft.includes(a.method === 'agent' ? 'publickey' : a.method)) continue
        if (a.method === 'keyboard-interactive') {
          // retry keyboard-interactive (e.g. PAM password / OTP) a few times before moving on
          if (kbdTries >= MAX_PROMPTS) continue
          kbdTries++
          if (kbdTries < MAX_PROMPTS) i--
        }
        try {
          const cfg = await a.run()
          if (!cfg) continue
          state.current = a
          return next(cfg as never)
        } catch (e) {
          if (e instanceof AuthCancelled) {
            state.cancelled = true
            onError(e)
            return next(false)
          }
          continue
        }
      }
      next(false)
    }
    void step()
    return undefined
  }
}
