# Prime Terminal

Portable SSH client for Linux and Windows: a classic terminal with tabs and multiple windows,
saved servers with proxy-jump chains, local shells and background port-forwarding sets.
The full specification is in [task.md](task.md).

## Development

```bash
npm install          # also rebuilds node-pty for Electron
npm run dev          # start with hot reload
npm test             # unit + integration tests (in-process SSH servers)
npm run typecheck
npm run lint
```

## Builds (local only)

| Command | Output | Build on |
|---|---|---|
| `npm run dist:linux` | `dist/prime-terminal-<version>-x86_64.AppImage` | Linux |
| `npm run dist:win` | `dist/prime-terminal-<version>-portable.exe` | Windows (needs Visual Studio Build Tools + Python for native modules) |

Cross-building the Windows exe on Linux is not supported (native modules).

## Desktop integration & command line

On the first start of the AppImage / portable exe the app offers to add itself to the app menu and
desktop search (Linux: `~/.local/share/applications`, Windows: Start menu), optionally with one
launcher per server and a `primeterminal` command. Change it later via ≡ → *Desktop integration…*.

```bash
primeterminal web-01            # saved server by name (or its host)
primeterminal deploy@10.0.0.5   # ad hoc
primeterminal --new-window a b  # several tabs in a new window
```

A running instance receives the arguments and opens the tabs there.

## Where things are stored

`~/.config/prime-terminal/` (Linux) or `%APPDATA%\prime-terminal\` (Windows):

- `servers.json` – servers, folders, local shells (passwords in plain text)
- `forward-sets.json` – port-forwarding sets
- `settings.json` – terminal settings and keybindings (applied live)
- `window-state.json` – last window position

Export/import of the whole configuration: main menu → *Export configuration…* creates a `.ptbackup`
file (a plain ZIP). Saved passwords are only included when you set an export password; they are
then stored encrypted in `secrets.enc`.

Host keys are checked against `~/.ssh/known_hosts`; keys default to `~/.ssh/id_*`;
a running ssh-agent / Pageant is used automatically.

## Architecture

- `src/main` – Electron main process. All sessions (`sessions/`), tunnels (`tunnels/`) and SSH
  connections (`ssh/`) live here, so a tab can move between windows without reconnecting.
  `app.ts` wires windows, IPC and the tab model.
- `src/preload` – the typed `window.pt` API (`api.ts`).
- `src/renderer` – React UI (xterm.js terminals, sidebar, dialogs, set manager with CodeMirror JSON view).
- `src/shared` – domain types and pure logic (validation, JSON exchange format, keybindings, schemas).

## Smoke testing

`PT_SMOKE_SCREENSHOT=/tmp/shot.png [PT_SMOKE_JS=script.js] electron .` runs an optional script in the
first window (it can use `window.pt`), saves a screenshot of every window and quits.
In packaged builds it additionally requires `PT_ALLOW_SMOKE=1`.
Use `HOME=/some/tmp XDG_CONFIG_HOME=/some/tmp/.config` to keep it away from your real config and known_hosts.
