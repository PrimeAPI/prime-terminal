// Domain types shared by main, preload and renderer.

export type AuthMethod = 'auto' | 'password' | 'key' | 'agent'

export interface SshAuth {
  method: AuthMethod
  password?: string
  keyPath?: string
  keyPassphrase?: string
}

export interface ServerProxyJump {
  enabled: boolean
  /** Ordered list of saved SSH server ids; first entry is the first hop. */
  chain: string[]
}

export interface SshServer {
  id: string
  type: 'ssh'
  name: string
  folderId?: string
  host: string
  port: number
  username: string
  auth: SshAuth
  proxyJump?: ServerProxyJump
}

export interface LocalServer {
  id: string
  type: 'local'
  name: string
  folderId?: string
  shell: string
  args?: string[]
  cwd?: string
  autoDetected?: boolean
  hidden?: boolean
}

export type Server = SshServer | LocalServer

export interface Folder {
  id: string
  name: string
  /** parent folder id; absent = top level */
  parentId?: string
}

export interface ServersDoc {
  folders: Folder[]
  servers: Server[]
}

export type ForwardType = 'local' | 'remote' | 'dynamic'

export interface ForwardEntry {
  id: string
  name?: string
  type: ForwardType
  enabled: boolean
  bindAddress?: string
  bindPort: number
  targetHost?: string
  targetPort?: number
}

export interface ForwardSet {
  id: string
  name: string
  /** Saved SSH server id. Empty string when the server could not be resolved on import. */
  server: string
  /** Name of the server that could not be resolved on import/paste. */
  unresolvedServer?: string
  /** absent = use the server's own jump config, [] = direct, list = this chain. */
  proxyJump?: string[]
  autoStart?: boolean
  forwards: ForwardEntry[]
}

export interface ForwardSetsDoc {
  sets: ForwardSet[]
}

export type KeybindingAction =
  | 'copy'
  | 'paste'
  | 'newTab'
  | 'closeTab'
  | 'newWindow'
  | 'prevTab'
  | 'nextTab'
  | 'moveTabLeft'
  | 'moveTabRight'
  | 'goToTab1'
  | 'goToTab2'
  | 'goToTab3'
  | 'goToTab4'
  | 'goToTab5'
  | 'goToTab6'
  | 'goToTab7'
  | 'goToTab8'
  | 'goToTab9'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'find'
  | 'toggleSidebar'
  | 'quickConnect'

export interface Settings {
  terminal: {
    fontFamily: string
    fontSize: number
    colorScheme: string
    scrollback: number
    copyOnSelect: boolean
    rightClick: 'paste' | 'menu'
    cursorStyle: 'block' | 'underline' | 'bar'
    cursorBlink: boolean
  }
  ssh: {
    keepaliveInterval: number
    connectTimeout: number
  }
  tunnels: {
    reconnectBackoffMin: number
    reconnectBackoffMax: number
  }
  keybindings: Partial<Record<KeybindingAction, string>>
}

// ---- runtime state shared over IPC ----

export type SessionState = 'connecting' | 'connected' | 'closed'

export interface TabInfo {
  sessionId: string
  title: string
  serverId: string | null
  kind: 'ssh' | 'local'
  state: SessionState
}

export interface WindowTabsState {
  windowId: number
  tabs: TabInfo[]
  activeSessionId: string | null
}

export type TunnelSetState = 'off' | 'connecting' | 'active' | 'reconnecting' | 'error'
export type TunnelEntryState = 'off' | 'active' | 'error'

export interface TunnelEntryStatus {
  id: string
  state: TunnelEntryState
  error?: string
}

/** A set counts as running while it is connecting, active or reconnecting. */
export function isTunnelRunning(s: { state: TunnelSetState } | undefined): boolean {
  return !!s && (s.state === 'connecting' || s.state === 'active' || s.state === 'reconnecting')
}

export interface TunnelSetStatus {
  setId: string
  state: TunnelSetState
  error?: string
  /** Epoch ms of the next reconnect attempt while reconnecting. */
  nextRetryAt?: number
  entries: TunnelEntryStatus[]
}

export interface ConfigSnapshot {
  servers: ServersDoc
  sets: ForwardSetsDoc
  settings: Settings
  /** Validation / parse errors of the files on disk (last valid state stays active). */
  errors: Partial<Record<ConfigFileKind, string>>
  paths: Record<ConfigFileKind, string>
}

export type ConfigFileKind = 'servers' | 'sets' | 'settings'

// ---- prompts (main -> renderer dialogs) ----

export type PromptRequest =
  | {
      kind: 'hostKey'
      status: 'unknown' | 'changed'
      host: string
      port: number
      keyType: string
      fingerprint: string
    }
  | {
      kind: 'secret'
      secret: 'password' | 'passphrase'
      serverName: string
      message: string
      allowSave: boolean
    }
  | {
      kind: 'keyboardInteractive'
      serverName: string
      name: string
      instructions: string
      prompts: { prompt: string; echo: boolean }[]
    }

export type PromptResponse =
  | { kind: 'hostKey'; trust: boolean }
  | { kind: 'secret'; value: string; save: boolean }
  | { kind: 'keyboardInteractive'; answers: string[] }
  | null

export interface MenuItemSpec {
  id?: string
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  accelerator?: string
}

export type OpenTarget = { serverId: string } | { adhoc: { username?: string; host: string; port?: number }; save?: boolean }
