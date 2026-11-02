import type { KeybindingAction } from './types'

export interface Accelerator {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** Normalized key name, upper-case (e.g. "C", "1", "PAGEUP", "PLUS"). */
  key: string
}

export interface KeyEventLike {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

const KEY_ALIASES: Record<string, string> = {
  '+': 'PLUS',
  '=': 'PLUS',
  ADD: 'PLUS',
  '-': 'MINUS',
  SUBTRACT: 'MINUS',
  ESC: 'ESCAPE',
  DEL: 'DELETE',
  PGUP: 'PAGEUP',
  PGDN: 'PAGEDOWN',
  RETURN: 'ENTER'
}

export function parseAccelerator(text: string): Accelerator | null {
  if (!text || !text.trim()) return null
  const parts = text.split('+').map((p) => p.trim())
  // "Ctrl++" style: trailing empty parts mean a literal plus
  const acc: Accelerator = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]
    const p = raw.toUpperCase()
    if (p === 'CTRL' || p === 'CONTROL') acc.ctrl = true
    else if (p === 'SHIFT') acc.shift = true
    else if (p === 'ALT' || p === 'OPTION') acc.alt = true
    else if (p === 'META' || p === 'SUPER' || p === 'CMD' || p === 'WIN') acc.meta = true
    else if (p === '') return null
    else {
      if (acc.key) return null
      acc.key = KEY_ALIASES[p] ?? p
    }
  }
  return acc.key ? acc : null
}

/** Normalize a DOM keyboard event's key into the accelerator key vocabulary. */
export function eventKey(e: KeyEventLike): string {
  if (e.code === 'NumpadAdd' || e.code === 'Equal' || e.key === '+') return 'PLUS'
  if (e.code === 'NumpadSubtract' || e.code === 'Minus' || e.key === '-' || e.key === '_') return 'MINUS'
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code)
  if (digit) return digit[1]
  if (e.key.length === 1) {
    const k = e.key.toUpperCase()
    return KEY_ALIASES[k] ?? k
  }
  const k = e.key.toUpperCase()
  return KEY_ALIASES[k] ?? k
}

function matches(acc: Accelerator, e: KeyEventLike, key: string): boolean {
  return (
    acc.key === key &&
    acc.ctrl === e.ctrlKey &&
    acc.shift === e.shiftKey &&
    acc.alt === e.altKey &&
    acc.meta === e.metaKey
  )
}

const cache = new Map<string, Accelerator | null>()
function cachedParse(text: string): Accelerator | null {
  let v = cache.get(text)
  if (v === undefined) {
    v = parseAccelerator(text)
    cache.set(text, v)
  }
  return v
}

export function matchAction(
  e: KeyEventLike,
  bindings: Partial<Record<KeybindingAction, string>>
): KeybindingAction | null {
  const key = eventKey(e)
  for (const [action, text] of Object.entries(bindings) as [KeybindingAction, string][]) {
    if (!text) continue
    const acc = cachedParse(text)
    if (acc && matches(acc, e, key)) return action
  }
  return null
}
