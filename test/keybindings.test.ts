import { describe, expect, it } from 'vitest'
import { matchAction, parseAccelerator } from '../src/shared/keybindings'
import { DEFAULT_KEYBINDINGS } from '../src/shared/defaults'

const ev = (o: Partial<{ key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }>) => ({
  key: '',
  code: '',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...o
})

describe('keybindings', () => {
  it('parses accelerators case-insensitively', () => {
    expect(parseAccelerator('ctrl+shift+c')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'C' })
    expect(parseAccelerator('Ctrl+Plus')?.key).toBe('PLUS')
    expect(parseAccelerator('nonsense+')).toBeNull()
    expect(parseAccelerator('Ctrl++')).toMatchObject({ ctrl: true, key: 'PLUS' })
  })

  it('maps Ctrl+Shift+C to copy but leaves plain Ctrl+C to the terminal', () => {
    expect(matchAction(ev({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }), DEFAULT_KEYBINDINGS)).toBe('copy')
    expect(matchAction(ev({ key: 'c', code: 'KeyC', ctrlKey: true }), DEFAULT_KEYBINDINGS)).toBeNull()
  })

  it('matches Alt+digits by physical key even when shifted symbols differ', () => {
    expect(matchAction(ev({ key: '1', code: 'Digit1', altKey: true }), DEFAULT_KEYBINDINGS)).toBe('goToTab1')
  })

  it('matches zoom on both = and + keys and the numpad', () => {
    expect(matchAction(ev({ key: '=', code: 'Equal', ctrlKey: true }), DEFAULT_KEYBINDINGS)).toBe('zoomIn')
    expect(matchAction(ev({ key: '+', code: 'BracketRight', ctrlKey: true }), DEFAULT_KEYBINDINGS)).toBe('zoomIn')
    expect(matchAction(ev({ key: '+', code: 'NumpadAdd', ctrlKey: true }), DEFAULT_KEYBINDINGS)).toBe('zoomIn')
    expect(matchAction(ev({ key: '-', code: 'Minus', ctrlKey: true }), DEFAULT_KEYBINDINGS)).toBe('zoomOut')
    // US layout: "+" needs Shift
    expect(matchAction(ev({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }), DEFAULT_KEYBINDINGS)).toBe('zoomIn')
  })

  it('uses the layout key for letters (QWERTZ: physical KeyY produces z)', () => {
    const bindings = { find: 'Ctrl+Shift+Z' }
    expect(matchAction(ev({ key: 'Z', code: 'KeyY', ctrlKey: true, shiftKey: true }), bindings)).toBe('find')
  })

  it('matches page keys and respects user overrides', () => {
    expect(matchAction(ev({ key: 'PageDown', code: 'PageDown', ctrlKey: true }), DEFAULT_KEYBINDINGS)).toBe('nextTab')
    expect(matchAction(ev({ key: 'PageDown', code: 'PageDown', ctrlKey: true, shiftKey: true }), DEFAULT_KEYBINDINGS)).toBe('moveTabRight')
    const custom = { ...DEFAULT_KEYBINDINGS, newTab: 'Ctrl+T' }
    expect(matchAction(ev({ key: 't', code: 'KeyT', ctrlKey: true }), custom)).toBe('newTab')
  })

  it('ignores empty bindings (disabled shortcut)', () => {
    expect(matchAction(ev({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }), { find: '' })).toBeNull()
  })
})
