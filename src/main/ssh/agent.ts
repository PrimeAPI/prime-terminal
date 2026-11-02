import { existsSync } from 'node:fs'

const WIN_OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/** Agents to try, in order: SSH_AUTH_SOCK on Unix; on Windows the OpenSSH agent pipe and Pageant. */
export function detectAgentPaths(): string[] {
  if (process.platform !== 'win32') return process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : []
  const out: string[] = []
  if (process.env.SSH_AUTH_SOCK) out.push(process.env.SSH_AUTH_SOCK)
  try {
    if (existsSync(WIN_OPENSSH_PIPE)) out.push(WIN_OPENSSH_PIPE)
  } catch {
    // ignore
  }
  out.push('pageant')
  return out
}
