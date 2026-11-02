// Routes interactive prompts (host keys, passwords, 2FA) to a renderer window and awaits the answer.

import type { WebContents } from 'electron'
import type { PromptRequest, PromptResponse } from '../shared/types'
import { newId } from '../shared/ids'
import type { Prompter } from './ssh/connect'

interface Pending {
  target: WebContents
  resolve: (r: PromptResponse) => void
}

export class PromptService {
  private pending = new Map<string, Pending>()

  request(target: WebContents | null, req: PromptRequest): Promise<PromptResponse> {
    if (!target || target.isDestroyed()) return Promise.resolve(null)
    const id = newId()
    return new Promise((resolve) => {
      this.pending.set(id, { target, resolve })
      target.send('prompts:request', id, req)
    })
  }

  respond(id: string, resp: PromptResponse): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve(resp)
    // remove the dialog in case it was answered by other means
    if (!p.target.isDestroyed()) p.target.send('prompts:cancel', id)
  }

  /** Cancel all prompts shown in a window that is closing. */
  cancelFor(target: WebContents): void {
    for (const [id, p] of this.pending) {
      if (p.target === target) {
        this.pending.delete(id)
        p.resolve(null)
      }
    }
  }

  prompter(target: () => WebContents | null): Prompter {
    return {
      hostKey: async (req) => {
        const r = await this.request(target(), req)
        return r?.kind === 'hostKey' ? r.trust : false
      },
      secret: async (req) => {
        const r = await this.request(target(), req)
        return r?.kind === 'secret' ? { value: r.value, save: r.save } : null
      },
      keyboardInteractive: async (req) => {
        const r = await this.request(target(), req)
        return r?.kind === 'keyboardInteractive' ? r.answers : null
      }
    }
  }
}
