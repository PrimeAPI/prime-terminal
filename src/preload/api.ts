// Typed API exposed to the renderer as `window.pt`.
import type {
  ConfigFileKind,
  ConfigSnapshot,
  ForwardSetsDoc,
  MenuItemSpec,
  OpenTarget,
  PromptRequest,
  PromptResponse,
  ServersDoc,
  TunnelSetStatus,
  WindowTabsState
} from '../shared/types'

export type SaveResult = { ok: true } | { ok: false; error: string }

export interface DesktopIntegrationStatus {
  supported: boolean
  platform: string
  enabled: boolean
  searchProvider: boolean
  cliCommand: boolean
  /** 'user': no password needed, 'system': asks for the admin password once */
  searchProviderSupport: 'user' | 'system' | 'unavailable'
  searchProviderNote: string
  /** installed by a system package: everything is set up already */
  installed: boolean
  /** ask once on the first start of the portable build */
  askOnStart: boolean
  command: string[]
  portable: boolean
}

export interface BackupInfo {
  createdAt: string
  hasSecrets: boolean
  counts: { servers: number; folders: number; sets: number }
}
export type Unsubscribe = () => void

export interface PtApi {
  platform: NodeJS.Platform | string
  config: {
    get(): Promise<ConfigSnapshot>
    onChange(cb: (c: ConfigSnapshot) => void): Unsubscribe
    saveServers(doc: ServersDoc): Promise<SaveResult>
    saveSets(doc: ForwardSetsDoc): Promise<SaveResult>
    readText(kind: ConfigFileKind): Promise<string>
    saveText(kind: ConfigFileKind, text: string): Promise<SaveResult>
    importSshConfig(): Promise<{ ok: true; added: number; warnings: string[] } | { ok: false; error: string }>
    pickKeyFile(): Promise<string | null>
    exportText(defaultName: string, text: string): Promise<boolean>
    importText(): Promise<string | null>
  }
  desktop: {
    get(): Promise<DesktopIntegrationStatus>
    apply(opts: { searchProvider: boolean; cliCommand: boolean }): Promise<SaveResult>
    remove(): Promise<SaveResult>
    dismiss(): void
  }
  backup: {
    /** Shows a save dialog; null = cancelled. Without password, secrets are not exported. */
    export(password?: string): Promise<{ ok: true; path: string } | { ok: false; error: string } | null>
    /** Shows an open dialog and inspects the file; null = cancelled. */
    pick(): Promise<{ ok: true; token: string; path: string; info: BackupInfo } | { ok: false; error: string } | null>
    import(token: string, opts: { password?: string; mode: 'merge' | 'replace' }): Promise<SaveResult>
  }
  sessions: {
    open(target: OpenTarget, opts?: { newWindow?: boolean; afterSessionId?: string }): Promise<SaveResult>
    attach(id: string, cols: number, rows: number): Promise<{ snapshot: string }>
    detach(id: string): void
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    onData(cb: (id: string, data: string) => void): Unsubscribe
  }
  tabs: {
    get(): Promise<WindowTabsState>
    onState(cb: (s: WindowTabsState) => void): Unsubscribe
    activate(id: string): void
    close(id: string): void
    closeOthers(id: string): void
    reorder(id: string, index: number): void
    moveBy(id: string, delta: number): void
    cycle(delta: number): void
    activateIndex(index: number): void
    rename(id: string, title: string): void
    duplicate(id: string): void
    moveToNewWindow(id: string): void
    dragStart(id: string): void
    dragEnd(id: string): void
    drop(index: number): void
  }
  windows: {
    newWindow(): void
    setTitle(title: string): void
  }
  tunnels: {
    status(): Promise<TunnelSetStatus[]>
    onStatus(cb: (s: TunnelSetStatus) => void): Unsubscribe
    activate(setId: string): Promise<void>
    deactivate(setId: string): Promise<void>
  }
  prompts: {
    onPrompt(cb: (id: string, req: PromptRequest) => void): Unsubscribe
    onCancel(cb: (id: string) => void): Unsubscribe
    respond(id: string, resp: PromptResponse): void
    /** the dialog host is mounted; queued prompts may be delivered */
    ready(): void
  }
  ui: {
    contextMenu(items: MenuItemSpec[]): Promise<string | null>
    clipboardRead(): Promise<string>
    clipboardWrite(text: string): void
    openExternal(url: string): void
    /** quick connect requested from the command line (unknown/ambiguous server) */
    onQuickConnectRequested(cb: () => void): Unsubscribe
    takeQuickConnect(): Promise<{ query: string; message: string } | null>
  }
}
