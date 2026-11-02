import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PtApi } from './api'

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void) {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

const invoke = ipcRenderer.invoke.bind(ipcRenderer)
const send = ipcRenderer.send.bind(ipcRenderer)

const api: PtApi = {
  platform: process.platform,
  config: {
    get: () => invoke('config:get'),
    onChange: (cb) => on('config:changed', cb),
    saveServers: (doc) => invoke('config:saveServers', doc),
    saveSets: (doc) => invoke('config:saveSets', doc),
    readText: (kind) => invoke('config:readText', kind),
    saveText: (kind, text) => invoke('config:saveText', kind, text),
    importSshConfig: () => invoke('config:importSshConfig'),
    pickKeyFile: () => invoke('config:pickKeyFile'),
    exportText: (name, text) => invoke('config:exportText', name, text),
    importText: () => invoke('config:importText')
  },
  backup: {
    export: (password) => invoke('backup:export', password),
    pick: () => invoke('backup:pick'),
    import: (token, opts) => invoke('backup:import', token, opts)
  },
  sessions: {
    open: (target, opts) => invoke('sessions:open', target, opts),
    attach: (id, cols, rows) => invoke('sessions:attach', id, cols, rows),
    detach: (id) => send('sessions:detach', id),
    write: (id, data) => send('sessions:write', id, data),
    resize: (id, cols, rows) => send('sessions:resize', id, cols, rows),
    onData: (cb) => on('sessions:data', cb)
  },
  tabs: {
    get: () => invoke('tabs:get'),
    onState: (cb) => on('tabs:state', cb),
    activate: (id) => send('tabs:activate', id),
    close: (id) => send('tabs:close', id),
    closeOthers: (id) => send('tabs:closeOthers', id),
    reorder: (id, index) => send('tabs:reorder', id, index),
    moveBy: (id, delta) => send('tabs:moveBy', id, delta),
    cycle: (delta) => send('tabs:cycle', delta),
    activateIndex: (index) => send('tabs:activateIndex', index),
    rename: (id, title) => send('tabs:rename', id, title),
    duplicate: (id) => send('tabs:duplicate', id),
    moveToNewWindow: (id) => send('tabs:moveToNewWindow', id),
    dragStart: (id) => send('tabs:dragStart', id),
    dragEnd: (id) => send('tabs:dragEnd', id),
    drop: (index) => send('tabs:drop', index)
  },
  windows: {
    newWindow: () => send('windows:new'),
    setTitle: (title) => send('windows:setTitle', title)
  },
  tunnels: {
    status: () => invoke('tunnels:status'),
    onStatus: (cb) => on('tunnels:status', cb),
    activate: (id) => invoke('tunnels:activate', id),
    deactivate: (id) => invoke('tunnels:deactivate', id)
  },
  prompts: {
    onPrompt: (cb) => on('prompts:request', cb),
    onCancel: (cb) => on('prompts:cancel', cb),
    respond: (id, resp) => send('prompts:respond', id, resp),
    ready: () => send('prompts:ready')
  },
  ui: {
    contextMenu: (items) => invoke('ui:contextMenu', items),
    clipboardRead: () => invoke('ui:clipboardRead'),
    clipboardWrite: (text) => send('ui:clipboardWrite', text),
    openExternal: (url) => send('ui:openExternal', url)
  }
}

contextBridge.exposeInMainWorld('pt', api)
