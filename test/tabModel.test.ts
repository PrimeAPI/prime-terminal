import { describe, expect, it } from 'vitest'
import { TabModel } from '../src/main/windows/tabModel'
import type { TabInfo } from '../src/shared/types'

const tab = (id: string): TabInfo => ({ sessionId: id, title: id, serverId: null, kind: 'local', state: 'connected' })
const ids = (m: TabModel, w: number) => m.state(w).tabs.map((t) => t.sessionId)

function model() {
  const m = new TabModel()
  m.addWindow(1)
  m.addWindow(2)
  for (const t of ['a', 'b', 'c']) m.addTab(1, tab(t))
  return m
}

describe('TabModel', () => {
  it('adds tabs at the end and activates them', () => {
    const m = model()
    expect(ids(m, 1)).toEqual(['a', 'b', 'c'])
    expect(m.state(1).activeSessionId).toBe('c')
  })

  it('reorders within a window and moves by offset with clamping', () => {
    const m = model()
    m.reorder('c', 0)
    expect(ids(m, 1)).toEqual(['c', 'a', 'b'])
    m.moveBy('c', -1)
    expect(ids(m, 1)).toEqual(['c', 'a', 'b'])
    m.moveBy('a', 1)
    expect(ids(m, 1)).toEqual(['c', 'b', 'a'])
  })

  it('activates the right neighbour (or left at the end) when closing the active tab', () => {
    const m = model()
    m.setActive('b')
    m.removeTab('b')
    expect(m.state(1).activeSessionId).toBe('c')
    m.removeTab('c')
    expect(m.state(1).activeSessionId).toBe('a')
  })

  it('moves a tab to another window at an index and keeps the source consistent', () => {
    const m = model()
    m.addTab(2, tab('x'))
    m.moveTab('b', 2, 0)
    expect(ids(m, 1)).toEqual(['a', 'c'])
    expect(ids(m, 2)).toEqual(['b', 'x'])
    expect(m.state(2).activeSessionId).toBe('b')
    expect(m.windowOf('b')).toBe(2)
  })

  it('cycles through tabs with wrap-around and jumps by index', () => {
    const m = model()
    m.cycle(1, 1)
    expect(m.state(1).activeSessionId).toBe('a')
    m.cycle(1, -1)
    expect(m.state(1).activeSessionId).toBe('c')
    m.activateIndex(1, 1)
    expect(m.state(1).activeSessionId).toBe('b')
    m.activateIndex(1, 9)
    expect(m.state(1).activeSessionId).toBe('b')
  })

  it('renames tabs, tracks state and reports affected windows', () => {
    const m = model()
    const changed: number[][] = []
    m.on('change', (w: number[]) => changed.push(w))
    m.rename('a', 'prod')
    m.setTabState('a', 'closed')
    expect(m.state(1).tabs[0]).toMatchObject({ title: 'prod', state: 'closed' })
    m.moveTab('a', 2)
    expect(changed.at(-1)!.sort()).toEqual([1, 2])
  })

  it('removing a window returns its sessions', () => {
    const m = model()
    expect(m.removeWindow(1)).toEqual(['a', 'b', 'c'])
    expect(m.windowOf('a')).toBeNull()
  })
})
