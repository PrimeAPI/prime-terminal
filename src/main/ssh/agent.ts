import { existsSync } from 'node:fs'

const WIN_OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/** Agent to use: SSH_AUTH_SOCK on Unix; OpenSSH pipe or Pageant on Windows. */
export function detectAgentPath(): string | null {
  if (process.platform === 'win32') {
    if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
    try {
      if (existsSync(WIN_OPENSSH_PIPE)) return WIN_OPENSSH_PIPE
    } catch {
      // ignore
    }
    return 'pageant'
  }
  return process.env.SSH_AUTH_SOCK || null
}
