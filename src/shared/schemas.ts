// JSON schemas for the config files. Used for validation in main and for
// linting/autocomplete in the renderer's JSON editor.

const port = { type: 'integer', minimum: 1, maximum: 65535 }

export const serversSchema = {
  $id: 'servers.json',
  type: 'object',
  additionalProperties: false,
  required: ['folders', 'servers'],
  properties: {
    folders: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name'],
        properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' } }
      }
    },
    servers: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'type', 'name', 'host', 'port', 'username', 'auth'],
            properties: {
              id: { type: 'string', minLength: 1 },
              type: { const: 'ssh' },
              name: { type: 'string', minLength: 1 },
              folderId: { type: 'string' },
              host: { type: 'string', minLength: 1 },
              port,
              username: { type: 'string' },
              auth: {
                type: 'object',
                additionalProperties: false,
                required: ['method'],
                properties: {
                  method: { enum: ['auto', 'password', 'key', 'agent'], description: 'auto = agent, ~/.ssh keys, password, keyboard-interactive' },
                  password: { type: 'string', description: 'Stored in plain text' },
                  keyPath: { type: 'string', description: 'Private key file; empty = default keys from ~/.ssh' },
                  keyPassphrase: { type: 'string', description: 'Stored in plain text' }
                }
              },
              proxyJump: {
                type: 'object',
                additionalProperties: false,
                required: ['enabled', 'chain'],
                properties: {
                  enabled: { type: 'boolean' },
                  chain: { type: 'array', items: { type: 'string' }, description: 'Ordered saved server ids; first = first hop' }
                }
              }
            }
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'type', 'name', 'shell'],
            properties: {
              id: { type: 'string', minLength: 1 },
              type: { const: 'local' },
              name: { type: 'string', minLength: 1 },
              folderId: { type: 'string' },
              shell: { type: 'string', minLength: 1 },
              args: { type: 'array', items: { type: 'string' } },
              cwd: { type: 'string' },
              autoDetected: { type: 'boolean' },
              hidden: { type: 'boolean' }
            }
          }
        ]
      }
    }
  }
} as const

const forwardEntry = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'enabled', 'bindPort'],
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    type: { enum: ['local', 'remote', 'dynamic'], description: 'local = -L, remote = -R, dynamic = -D (SOCKS5)' },
    enabled: { type: 'boolean' },
    bindAddress: { type: 'string', description: 'Default 127.0.0.1' },
    bindPort: port,
    targetHost: { type: 'string' },
    targetPort: port
  }
}

export const setsSchema = {
  $id: 'forward-sets.json',
  type: 'object',
  additionalProperties: false,
  required: ['sets'],
  properties: {
    sets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'server', 'forwards'],
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          server: { type: 'string', description: 'Saved SSH server id' },
          unresolvedServer: { type: 'string' },
          proxyJump: {
            type: 'array',
            items: { type: 'string' },
            description: 'absent = server default, [] = direct, list = this chain (server ids)'
          },
          autoStart: { type: 'boolean', description: 'Activate when the app starts' },
          forwards: { type: 'array', items: forwardEntry }
        }
      }
    }
  }
} as const

/** Schema of the portable exchange format of a single set (JSON view, clipboard). */
export const exchangeSetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'server', 'forwards'],
  properties: {
    name: { type: 'string' },
    server: { type: 'string', description: 'Name of a saved SSH server' },
    proxyJump: { type: 'array', items: { type: 'string' }, description: 'absent = server default, [] = direct, list = server names' },
    autoStart: { type: 'boolean' },
    forwards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'bindPort'],
        properties: {
          name: { type: 'string' },
          type: { enum: ['local', 'remote', 'dynamic'] },
          enabled: { type: 'boolean' },
          bindAddress: { type: 'string' },
          bindPort: port,
          targetHost: { type: 'string' },
          targetPort: port
        }
      }
    }
  }
} as const

export const COLOR_SCHEMES = ['dark', 'light', 'solarized-dark', 'solarized-light', 'gruvbox-dark', 'nord'] as const

const keybindingActions = [
  'copy', 'paste', 'newTab', 'closeTab', 'newWindow', 'prevTab', 'nextTab', 'moveTabLeft', 'moveTabRight',
  'goToTab1', 'goToTab2', 'goToTab3', 'goToTab4', 'goToTab5', 'goToTab6', 'goToTab7', 'goToTab8', 'goToTab9',
  'zoomIn', 'zoomOut', 'zoomReset', 'find', 'toggleSidebar', 'quickConnect'
]

export const settingsSchema = {
  $id: 'settings.json',
  type: 'object',
  additionalProperties: false,
  properties: {
    terminal: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fontFamily: { type: 'string' },
        fontSize: { type: 'number', minimum: 6, maximum: 72 },
        colorScheme: { enum: [...COLOR_SCHEMES] },
        scrollback: { type: 'integer', minimum: 0, maximum: 1000000 },
        copyOnSelect: { type: 'boolean' },
        rightClick: { enum: ['paste', 'menu'] },
        cursorStyle: { enum: ['block', 'underline', 'bar'] },
        cursorBlink: { type: 'boolean' }
      }
    },
    ssh: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keepaliveInterval: { type: 'number', minimum: 0, description: 'seconds, 0 = off' },
        connectTimeout: { type: 'number', minimum: 1, description: 'seconds' }
      }
    },
    tunnels: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reconnectBackoffMin: { type: 'number', exclusiveMinimum: 0, description: 'seconds' },
        reconnectBackoffMax: { type: 'number', exclusiveMinimum: 0, description: 'seconds' }
      }
    },
    keybindings: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        keybindingActions.map((a) => [a, { type: 'string', description: 'e.g. "Ctrl+Shift+T"; empty string disables' }])
      )
    }
  }
} as const
