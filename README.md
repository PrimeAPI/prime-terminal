# Prime Terminal

A simple SSH client for Linux and Windows: a classic terminal with tabs and windows, saved servers,
proxy jumps and port forwarding sets that run in the background.

![icon](build/icons/128x128.png)

## Install

### Ubuntu / Debian (apt, with automatic updates)

```bash
sudo curl -fsSLo /usr/share/keyrings/prime-terminal.gpg \
  https://github.com/PrimeAPI/prime-terminal/releases/latest/download/prime-terminal.gpg
echo "deb [signed-by=/usr/share/keyrings/prime-terminal.gpg] https://github.com/PrimeAPI/prime-terminal/releases/latest/download ./" \
  | sudo tee /etc/apt/sources.list.d/prime-terminal.list
sudo apt update && sudo apt install prime-terminal
```

New versions then arrive with the normal system updates (`sudo apt upgrade`).

### Snap

```bash
sudo snap install prime-terminal --classic
```

### Other downloads

From the [releases page](https://github.com/PrimeAPI/prime-terminal/releases):

| File | System | |
|---|---|---|
| `prime-terminal-<version>-portable.exe` | Windows 10/11 | portable, just run it |
| `prime-terminal-<version>-x86_64.AppImage` | Linux | portable: `chmod +x` and run it |
| `prime-terminal_<version>_amd64.deb` | Debian / Ubuntu | `sudo apt install ./prime-terminal_<version>_amd64.deb` |

On the first start the portable versions offer to add themselves to the app menu and search.
The apt and snap packages set this up during installation.

The Windows exe is not code-signed, so SmartScreen shows a warning on the first start
(*More info → Run anyway*).

## Features

- Tabs and multiple windows. Drag a tab out of the window to get a new window, or drag it into another window.
- Saved servers in nested folders, with password, SSH key or agent authentication.
- Host keys are checked against `~/.ssh/known_hosts`. You can import hosts from `~/.ssh/config`.
- Proxy jumps through one or more saved servers.
- Port forwarding sets (local, remote and SOCKS):
  - start and stop them from the ⇄ button
  - auto-start and auto-reconnect
  - edit them as a table or as JSON
- Local shells: bash, PowerShell, cmd, Git Bash, WSL.
- Export and import of the whole configuration (`.ptbackup`). Passwords are only included when you set an export password, and are then stored encrypted.
- GNOME search shows your servers as results of Prime Terminal. The command line works the same way:

  ```bash
  primeterminal web-01              # saved server (name or host)
  primeterminal deploy@10.0.0.5     # any host
  primeterminal --new-window a b    # several tabs in a new window
  ```

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl+C` | interrupt (always goes to the terminal) |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | copy / paste |
| `Ctrl+Shift+T` / `Ctrl+Shift+O` | new tab / quick connect |
| `Ctrl+Shift+W` | close tab |
| `Ctrl+Shift+N` | new window |
| `Ctrl+PgUp` / `Ctrl+PgDn` | previous / next tab |
| `Alt+1` … `Alt+9` | go to tab |
| `Ctrl+Shift+F` | search in the scrollback |
| `Ctrl+Shift+B` | toggle the server list |

All shortcuts can be changed in `settings.json` (menu ≡ → Settings).

## Configuration

Stored in `~/.config/prime-terminal/` (Linux) or `%APPDATA%\prime-terminal\` (Windows):
`servers.json`, `forward-sets.json` and `settings.json`. All three are plain JSON, can be edited by
hand and are reloaded automatically. Saved passwords are stored in plain text in `servers.json`.

## Development

```bash
npm install
npm run dev          # start with hot reload
npm test             # unit and integration tests
npm run lint && npm run typecheck
npm run dist:linux   # AppImage + .deb in dist/
npm run dist:win     # portable exe (on Windows)
```

Releases are built by GitHub Actions: push a tag like `v1.2.3` and GitHub Actions will
- build the exe, AppImage, deb and snap,
- create the GitHub release including the signed APT repository files,
- publish the snap to the Snap Store.

One-time setup for maintainers:
- APT signing key: `scripts/setup-apt-signing-key.sh`
- Snap Store credentials: the `SNAPCRAFT_STORE_CREDENTIALS` secret

The detailed specification is in [docs/SPEC.md](docs/SPEC.md) (German).
