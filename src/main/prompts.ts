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
  /** renderers whose prompt dialog host is mounted */
  private ready = new WeakSet<WebContents>()
  private queued = new Map<WebContents, (() => void)[]>()

  /** Called when a renderer's PromptHost is mounted (prompts sent before that would be lost). */
  markReady(target: WebContents): void {
    this.ready.add(target)
    const q = this.queued.get(target) ?? []
    this.queued.delete(target)
    for (const send of q) send()
    target.once('did-start-loading', () => this.ready.delete(target))
  }

  request(target: WebContents | null, req: PromptRequest): Promise<PromptResponse> {
    if (!target || target.isDestroyed()) return Promise.resolve(null)
    const id = newId()
    return new Promise((resolve) => {
      this.pending.set(id, { target, resolve })
      const send = () => {
        if (!target.isDestroyed()) target.send('prompts:request', id, req)
      }
      if (this.ready.has(target)) send()
      else this.queued.set(target, [...(this.queued.get(target) ?? []), send])
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
    this.queued.delete(target)
    for (const [id, p] of this.pending) {
      if (p.target === target) {
        this.pending.delete(id)
        p.resolve(null)
      }
    }
  }

  /** Prompter for background work that must never show dialogs (automatic reconnects). */
  static readonly silent: Prompter = {
    hostKey: async () => false,
    secret: async () => null,
    keyboardInteractive: async () => null
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
