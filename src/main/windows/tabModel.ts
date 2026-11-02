// Which tabs (sessions) live in which window, in which order, and which one is active.

import { EventEmitter } from 'node:events'
import type { SessionState, TabInfo, WindowTabsState } from '../../shared/types'

interface Win {
  tabs: TabInfo[]
  active: string | null
}

/** Emits 'change' (windowIds: number[]) after every mutation. */
export class TabModel extends EventEmitter {
  private windows = new Map<number, Win>()

  addWindow(id: number): void {
    if (!this.windows.has(id)) this.windows.set(id, { tabs: [], active: null })
  }

  removeWindow(id: number): string[] {
    const w = this.windows.get(id)
    this.windows.delete(id)
    return w ? w.tabs.map((t) => t.sessionId) : []
  }

  windowIds(): number[] {
    return [...this.windows.keys()]
  }

  windowOf(sessionId: string): number | null {
    for (const [id, w] of this.windows) if (w.tabs.some((t) => t.sessionId === sessionId)) return id
    return null
  }

  tab(sessionId: string): TabInfo | undefined {
    for (const w of this.windows.values()) {
      const t = w.tabs.find((x) => x.sessionId === sessionId)
      if (t) return t
    }
    return undefined
  }

  state(id: number): WindowTabsState {
    const w = this.windows.get(id)
    return { windowId: id, tabs: w ? w.tabs.map((t) => ({ ...t })) : [], activeSessionId: w?.active ?? null }
  }

  private changed(...ids: number[]) {
    this.emit('change', [...new Set(ids)])
  }

  private locate(sessionId: string): { winId: number; w: Win; index: number } | null {
    for (const [winId, w] of this.windows) {
      const index = w.tabs.findIndex((t) => t.sessionId === sessionId)
      if (index >= 0) return { winId, w, index }
    }
    return null
  }

  addTab(winId: number, tab: TabInfo, index?: number): void {
    const w = this.windows.get(winId)
    if (!w) return
    const i = index === undefined ? w.tabs.length : Math.max(0, Math.min(index, w.tabs.length))
    w.tabs.splice(i, 0, tab)
    w.active = tab.sessionId
    this.changed(winId)
  }

  /** Detach a tab from its window without notifying (used by removeTab/moveTab). */
  private detach(sessionId: string): { winId: number; tab: TabInfo } | null {
    const loc = this.locate(sessionId)
    if (!loc) return null
    const { w, index } = loc
    const [tab] = w.tabs.splice(index, 1)
    if (w.active === sessionId) {
      w.active = w.tabs[index]?.sessionId ?? w.tabs[index - 1]?.sessionId ?? null
    }
    return { winId: loc.winId, tab }
  }

  removeTab(sessionId: string): number | null {
    const d = this.detach(sessionId)
    if (!d) return null
    this.changed(d.winId)
    return d.winId
  }

  moveTab(sessionId: string, toWin: number, index?: number): void {
    if (!this.windows.has(toWin)) return
    const d = this.detach(sessionId)
    if (!d) return
    const w = this.windows.get(toWin)!
    const i = index === undefined ? w.tabs.length : Math.max(0, Math.min(index, w.tabs.length))
    w.tabs.splice(i, 0, d.tab)
    w.active = sessionId
    this.changed(d.winId, toWin)
  }

  reorder(sessionId: string, index: number): void {
    const loc = this.locate(sessionId)
    if (!loc) return
    const [t] = loc.w.tabs.splice(loc.index, 1)
    const i = Math.max(0, Math.min(index, loc.w.tabs.length))
    loc.w.tabs.splice(i, 0, t)
    this.changed(loc.winId)
  }

  moveBy(sessionId: string, delta: number): void {
    const loc = this.locate(sessionId)
    if (loc) this.reorder(sessionId, loc.index + delta)
  }

  setActive(sessionId: string): void {
    const loc = this.locate(sessionId)
    if (!loc || loc.w.active === sessionId) return
    loc.w.active = sessionId
    this.changed(loc.winId)
  }

  cycle(winId: number, delta: number): void {
    const w = this.windows.get(winId)
    if (!w || w.tabs.length === 0) return
    const cur = Math.max(0, w.tabs.findIndex((t) => t.sessionId === w.active))
    const next = (cur + delta + w.tabs.length) % w.tabs.length
    this.setActive(w.tabs[next].sessionId)
  }

  activateIndex(winId: number, index: number): void {
    const t = this.windows.get(winId)?.tabs[index]
    if (t) this.setActive(t.sessionId)
  }

  rename(sessionId: string, title: string): void {
    const loc = this.locate(sessionId)
    if (!loc) return
    loc.w.tabs[loc.index] = { ...loc.w.tabs[loc.index], title }
    this.changed(loc.winId)
  }

  setTabState(sessionId: string, state: SessionState): void {
    const loc = this.locate(sessionId)
    if (!loc) return
    loc.w.tabs[loc.index] = { ...loc.w.tabs[loc.index], state }
    this.changed(loc.winId)
  }
}
