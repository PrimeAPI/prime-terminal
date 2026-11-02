import type { ForwardSetsDoc, KeybindingAction, ServersDoc, Settings } from './types'

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string> = {
  copy: 'Ctrl+Shift+C',
  paste: 'Ctrl+Shift+V',
  newTab: 'Ctrl+Shift+T',
  closeTab: 'Ctrl+Shift+W',
  newWindow: 'Ctrl+Shift+N',
  prevTab: 'Ctrl+PageUp',
  nextTab: 'Ctrl+PageDown',
  moveTabLeft: 'Ctrl+Shift+PageUp',
  moveTabRight: 'Ctrl+Shift+PageDown',
  goToTab1: 'Alt+1',
  goToTab2: 'Alt+2',
  goToTab3: 'Alt+3',
  goToTab4: 'Alt+4',
  goToTab5: 'Alt+5',
  goToTab6: 'Alt+6',
  goToTab7: 'Alt+7',
  goToTab8: 'Alt+8',
  goToTab9: 'Alt+9',
  zoomIn: 'Ctrl+Plus',
  zoomOut: 'Ctrl+Minus',
  zoomReset: 'Ctrl+0',
  find: 'Ctrl+Shift+F',
  toggleSidebar: 'Ctrl+Shift+B',
  quickConnect: 'Ctrl+Shift+O'
}

export function defaultSettings(): Settings {
  return {
    terminal: {
      fontFamily: 'monospace',
      fontSize: 13,
      colorScheme: 'dark',
      scrollback: 10000,
      copyOnSelect: false,
      rightClick: 'paste',
      cursorStyle: 'block',
      cursorBlink: true
    },
    ssh: { keepaliveInterval: 30, connectTimeout: 15 },
    tunnels: { reconnectBackoffMin: 1, reconnectBackoffMax: 60 },
    keybindings: { ...DEFAULT_KEYBINDINGS }
  }
}

export function defaultServersDoc(): ServersDoc {
  return { folders: [], servers: [] }
}

export function defaultSetsDoc(): ForwardSetsDoc {
  return { sets: [] }
}

/** Fill missing settings keys with defaults (user files may be partial). */
export function withSettingsDefaults(partial: Partial<Settings> | undefined): Settings {
  const d = defaultSettings()
  const p = partial ?? {}
  return {
    terminal: { ...d.terminal, ...(p.terminal ?? {}) },
    ssh: { ...d.ssh, ...(p.ssh ?? {}) },
    tunnels: { ...d.tunnels, ...(p.tunnels ?? {}) },
    keybindings: { ...d.keybindings, ...(p.keybindings ?? {}) }
  }
}
