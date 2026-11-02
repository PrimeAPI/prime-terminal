# Task: Prime Terminal – plattformübergreifender SSH-Client

Dieses Dokument ist die verbindliche Spezifikation für v1. Es fasst das ursprüngliche
Anforderungsdokument und alle in der Abstimmung getroffenen Entscheidungen zusammen.
Bei Widersprüchen gilt dieses Dokument.

---

## 1. Ziel

Eine schlichte, portable Desktop-App (Linux + Windows), die als vollwertiger SSH-Client dient.
Im Mittelpunkt steht ein klassisches Terminal mit Tabs und mehreren Fenstern. Zentrales
Zusatzfeature ist Port Forwarding in Sets, das im Hintergrund läuft.

Designprinzipien: schlicht, aufgeräumt, Fokus auf dem Terminal, keine Effekte, keine
Dekoration und nichts Überladenes. Funktionen sollen intuitiv auffindbar sein. Die UI-Sprache ist **ausschließlich Englisch** (kein i18n).

---

## 2. Technologie-Stack (festgelegt)

| Bereich | Wahl |
|---|---|
| App-Framework | **Electron** |
| Sprache | **TypeScript** (Main, Preload, Renderer) |
| SSH | **`ssh2`** (Node), läuft im Main-Prozess |
| Terminal-Rendering | **xterm.js** (+ Addons: fit, search, web-links, webgl mit Canvas-Fallback) |
| Lokale Shells | **`node-pty`** (ConPTY unter Windows) |
| JSON-Editor | **CodeMirror 6** mit JSON-Schema-Validierung |
| Packaging | **electron-builder** (`portable` für Windows, `AppImage` für Linux) |
| Build | **lokal** über npm-Scripts (GitHub Actions erst später, siehe 3.1) |

**Architekturgrundsatz:** Alle Sitzungen (SSH, lokale PTYs) und alle Tunnel leben im
**Main-Prozess**. Renderer-Fenster sind nur Ansichten, die über IPC an eine Sitzungs-ID gebunden
sind. Nur so kann ein Tab ohne Verbindungsabbruch in ein anderes Fenster wandern.

---

## 3. Plattformen & Bereitstellung

- Zielplattformen: **Linux x64** und **Windows x64**.
- Keine Installation nötig:
  - Windows: **portable `.exe`** (unsigniert; die SmartScreen-Warnung beim ersten Start wird akzeptiert).
  - Linux: **`AppImage`**.
- Konfiguration liegt im **Benutzerprofil**:
  - Linux: `~/.config/prime-terminal/`
  - Windows: `%APPDATA%\prime-terminal\`
### 3.1 Builds

- Lokal:
  - `npm run dist:linux` erzeugt `AppImage` und `.deb`.
  - `npm run dist:win` erzeugt die portable `.exe`; das geht nur auf Windows, wegen der nativen Module.
- GitHub Actions (`.github/workflows/build.yml`):
  - Bei jedem Push und PR laufen Lint, Typecheck, Tests und Builds.
  - Bei einem Tag `v*` wird ein GitHub Release mit `.exe`, `.AppImage` und `.deb` erstellt. Die Version kommt aus dem Tag.
- Die `.deb` installiert zusätzlich:
  - den GNOME-Search-Provider
  - `/usr/bin/primeterminal`
  - ein AppArmor-Profil für Ubuntu 24.04+
- Die AppImage startet auf Systemen mit eingeschränkten User-Namespaces (Ubuntu 24.04+) automatisch mit `--no-sandbox`. Eine AppImage kann den SUID-Sandbox-Helper nicht nutzen.

### 3.2 Verteilung mit automatischen Updates

- **APT:**
  - Jedes Release enthält signierte Repository-Dateien: `Packages`, `Packages.gz`, `Release`, `InRelease`, `Release.gpg` und den öffentlichen Schlüssel `prime-terminal.gpg`.
  - `https://github.com/PrimeAPI/prime-terminal/releases/latest/download` dient damit als „flaches“ APT-Repository. GitHub leitet `latest` immer auf das neueste Release weiter, und `apt upgrade` liefert neue Versionen.
  - Signiert wird mit dem Secret `APT_SIGNING_KEY` (einmalig `scripts/setup-apt-signing-key.sh`).
- **Snap:**
  - `confinement: classic`. Ein SSH-Client braucht `~/.ssh`, den ssh-agent und die Shells des Benutzers.
  - Bei jedem Tag wird der Snap in den Kanal `stable` hochgeladen (Secret `SNAPCRAFT_STORE_CREDENTIALS`).
  - Der Snap nutzt dieselbe Konfiguration in `~/.config/prime-terminal` wie die anderen Varianten.
- Fehlt eines der Secrets, wird der jeweilige Schritt mit einer Warnung übersprungen. Das Release entsteht trotzdem.

---

## 4. Datenmodell & Konfigurationsdateien

Alle Dateien sind JSON, menschenlesbar und von Hand editierbar. Passwörter und
Key-Passphrasen werden **im Klartext** gespeichert. Das ist bewusst so entschieden (wie bei MobaXterm).

```
prime-terminal/
  servers.json        # gespeicherte Verbindungen (SSH + lokal), Ordner
  forward-sets.json   # Port-Forwarding-Sets
  settings.json       # Terminal-/UI-Einstellungen + Keybindings
```

- Jedes Objekt hat eine stabile `id` (UUID).
- Bei Änderungen an den Dateien von außen werden sie neu geladen (Datei-Watcher). Bei ungültigem JSON
  bleibt der letzte gültige Stand aktiv, und es erscheint eine Fehlermeldung.

### 4.1 Server (`servers.json`)

Zwei Typen: `ssh` und `local`.

```jsonc
{
  "folders": [{ "id": "…", "name": "Production" }],
  "servers": [
    {
      "id": "…",
      "type": "ssh",
      "name": "web-01",
      "folderId": "…",            // optional
      "host": "web-01.example.com",
      "port": 22,
      "username": "deploy",
      "auth": {
        "method": "key",          // "password" | "key" | "agent" | "auto"
        "password": "…",          // bei method=password (Klartext)
        "keyPath": "~/.ssh/id_ed25519", // bei method=key; leer = Standard-Keys aus ~/.ssh probieren
        "keyPassphrase": "…"      // optional, Klartext
      },
      "proxyJump": {
        "enabled": true,          // Schalter: Kette an/aus
        "chain": ["<serverId>", "<serverId>"]  // geordnet, erster = erster Hop
      }
    },
    {
      "id": "…",
      "type": "local",
      "name": "PowerShell 7",
      "shell": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "args": [],
      "cwd": "~",
      "autoDetected": true
    }
  ]
}
```

Regeln:
- `auth.method = "auto"` (Default): Reihenfolge Agent, dann Keys aus `~/.ssh` (`id_ed25519`, `id_ecdsa`, `id_rsa`), dann Passwort (falls gespeichert, sonst Abfrage), dann keyboard-interactive.
- Ist ein Passwort oder eine Passphrase nötig, aber nicht gespeichert, erscheint ein Dialog. Dort gibt es die Checkbox „Save password“.
- **Proxy Jumps:** Jeder Hop verweist auf einen **gespeicherten SSH-Server** und nutzt dessen Host, Port, User und Auth. Die eigenen Jumps eines Hop-Servers werden **nicht** rekursiv aufgelöst; die Kette ist immer explizit. Zyklen und Selbstreferenzen werden beim Speichern abgelehnt.
- `local`-Server können weder Jump-Host noch Ziel eines Forwarding-Sets sein.

### 4.2 Port-Forwarding-Sets (`forward-sets.json`)

Ein Set enthält **seinen Zielserver und optional eine eigene Proxy-Jump-Kette**.

```jsonc
{
  "sets": [
    {
      "id": "…",
      "name": "App X",
      "server": "<serverId>",       // Pflicht: gespeicherter SSH-Server
      "proxyJump": ["<serverId>"],  // optional, siehe Regeln
      "autoStart": false,           // beim App-Start automatisch aktivieren
      "forwards": [
        { "id": "…", "name": "db",    "type": "local",   "enabled": true,
          "bindAddress": "127.0.0.1", "bindPort": 5432, "targetHost": "db.internal", "targetPort": 5432 },
        { "id": "…", "name": "hook",  "type": "remote",  "enabled": true,
          "bindAddress": "127.0.0.1", "bindPort": 9000, "targetHost": "localhost",   "targetPort": 3000 },
        { "id": "…", "name": "socks", "type": "dynamic", "enabled": true,
          "bindAddress": "127.0.0.1", "bindPort": 1080 }
      ]
    }
  ]
}
```

Regeln:
- `type`: `local` (-L), `remote` (-R) oder `dynamic` (-D, SOCKS5). Der Nutzer wählt den Typ pro Eintrag.
- `proxyJump`:
  - Feld fehlt: Die Jump-Konfiguration des Zielservers wird verwendet (inklusive dessen An/Aus-Schalter).
  - `[]`: direkte Verbindung ohne Jumps.
  - Liste: genau diese Kette.
- `enabled` pro Eintrag: Deaktivierte Einträge werden beim Aktivieren des Sets übersprungen.
- `bindAddress` hat den Default `127.0.0.1`.
- Ein Set ist zur gleichen Zeit höchstens einmal aktiv.

**Austauschformat (Copy/Paste, Export/Import):** Ein Set oder ein Eintrag wird als JSON in die
System-Zwischenablage kopiert. Beim **Export** werden Server-Referenzen zusätzlich als
Name aufgelöst (`"serverName": "web-01"`), damit der Import auf einer anderen Installation funktioniert.
Beim **Import/Paste** wird zuerst die `id`, dann der Name aufgelöst. Lässt sich ein Server nicht
auflösen, wird das Set trotzdem importiert, aber als „unresolved server“ markiert und kann erst
nach Zuordnung aktiviert werden. Beim Paste werden neue `id`s vergeben.

### 4.3 Settings (`settings.json`)

Alle Einstellungen sind über diese Datei editierbar. In der App gibt es „Settings → Open settings.json“,
das die Datei im integrierten JSON-Editor öffnet, mit Schema-Validierung und Autocomplete.
Gespeicherte Änderungen wirken **sofort** (Live-Reload). Eine eigene Settings-Formular-UI ist für v1
**nicht** nötig.

```jsonc
{
  "terminal": {
    "fontFamily": "monospace",
    "fontSize": 13,
    "colorScheme": "dark",          // Presets: dark (Default), light, solarized-dark, solarized-light, …
    "scrollback": 10000,
    "copyOnSelect": false,
    "rightClick": "paste",          // "paste" | "menu"
    "cursorStyle": "block",
    "cursorBlink": true
  },
  "ssh": {
    "keepaliveInterval": 30,
    "connectTimeout": 15
  },
  "tunnels": {
    "reconnectBackoffMin": 1,
    "reconnectBackoffMax": 60
  },
  "keybindings": { "newTab": "Ctrl+Shift+T", "…": "…" }
}
```

---

## 5. SSH-Verbindungen

- Server lassen sich anlegen, bearbeiten, duplizieren und löschen (Dialog). Ordner lassen sich anlegen, umbenennen und löschen.
- Authentifizierung:
  - Passwort
  - SSH-Key mit wählbarem Key-Pfad (Dateidialog, Start in `~/.ssh`)
  - Standard-Keys aus `~/.ssh`
  - **ssh-agent**: unter Linux `SSH_AUTH_SOCK`, unter Windows die OpenSSH-Agent-Pipe `\\.\pipe\openssh-ssh-agent` und Pageant
  - **keyboard-interactive** für 2FA/OTP-Prompts im Dialog
  - Verschlüsselte Keys über Passphrase, gespeichert oder abgefragt
- **Host-Key-Prüfung** gegen `~/.ssh/known_hosts` (lesen und schreiben):
  - Unbekannter Host: Ein Dialog zeigt den Fingerprint (SHA256) mit der Frage „Trust and save?“. Bei Zustimmung wird der Key in `known_hosts` geschrieben.
  - **Geänderter** Key: Die Verbindung wird hart blockiert, mit deutlicher Warnung. Es gibt keinen „trotzdem verbinden“-Button.
  - Hashed-Einträge (`|1|…`) in `known_hosts` müssen gelesen werden können.
- Proxy Jumps über eine Kette beliebiger Länge (via `forwardOut` bzw. `direct-tcpip`). Der An/Aus-Schalter pro Server ist auch direkt im Kontextmenü der Serverliste erreichbar.
- **Import aus `~/.ssh/config`**: einmalig über „Import from ~/.ssh/config“. Ausgewertet werden
  `Host` (ohne Wildcards), `HostName`, `User`, `Port`, `IdentityFile` und `ProxyJump`. ProxyJump-Hosts werden, falls nötig,
  als eigene Server angelegt und verknüpft. `Match` und `Include` werden ignoriert, mit Hinweis.
  Ein Live-Abgleich findet nicht statt.

---

## 6. Lokale Shells

- Sie erscheinen als Servertyp `local` in derselben Serverliste und öffnen sich wie SSH-Sitzungen in Tabs.
- **Automatische Erkennung** beim Start (Einträge mit `autoDetected: true`; sie lassen sich ausblenden, aber nicht dauerhaft löschen):
  - Linux: `$SHELL` (Fallback `/bin/bash`)
  - Windows: PowerShell 7 (`pwsh`), Windows PowerShell, cmd, Git Bash (falls installiert), alle WSL-Distros (`wsl -l -q`)
- Eigene lokale Profile mit Shell-Pfad, Argumenten und Startverzeichnis sind möglich.

---

## 7. Port Forwarding

### 7.1 Laufzeitverhalten

- Tunnel laufen **ausschließlich im Hintergrund**. Sie haben nie einen Terminal-Tab und sind von offenen Tabs unabhängig.
- Jedes aktive Set baut seine eigene SSH-Verbindung auf (inklusive Jumps). Ein Terminal-Tab und ein Set teilen sich keine Verbindung.
- Alle Einträge eines Sets werden gemeinsam aktiviert und deaktiviert. Deaktivierte Einträge (`enabled: false`) werden übersprungen.
- **Teilfehler:** Schlägt ein einzelner Eintrag fehl (z. B. Port belegt), laufen die übrigen weiter. Der Status wird pro Eintrag angezeigt, mit Fehlertext.
- **Verbindungsfehler beim Aktivieren** (Auth, Host nicht erreichbar, Host-Key, …): **kein** automatischer Retry. Das Set geht auf „error“ und zeigt die Fehlermeldung.
- **Abbruch einer bereits aufgebauten Verbindung:** automatischer Reconnect mit exponentiellem
  Backoff (1 s, 2 s, 4 s, … bis max. 60 s, einstellbar). Der Status lautet dabei „reconnecting“. Manuelles Deaktivieren bricht den Reconnect ab.
- Keepalive alle 30 s (einstellbar).
- **Auto-Start:** Sets mit `autoStart: true` werden beim App-Start automatisch aktiviert.
- **Beim Beenden der App werden alle Tunnel geschlossen.** Es gibt kein Tray-Icon und keinen Hintergrundbetrieb ohne Fenster;
  schließt man das letzte Fenster, wird die App beendet.

### 7.2 Tunnel-Popup (Steuerung)

- Ein kleiner **Button in der Tab-Leiste jedes Fensters** öffnet ein Popup bzw. Dropdown, kein eigenes Fenster und keinen Tab.
- Das Button-Icon zeigt den Gesamtstatus: keine Tunnel, alle ok, Fehler oder reconnecting.
- Inhalt des Popups:
  - Liste aller Sets mit An/Aus-Schalter, Statusindikator (off, connecting, active, reconnecting, error) und Zielserver
  - Aufklappbar pro Set: einzelne Einträge mit Status und Fehlertext
  - Link „Manage sets…“, der die Set-Verwaltung öffnet
- Der Zustand ist in allen Fenstern synchron, weil er im Main-Prozess liegt.

### 7.3 Set-Verwaltung (UI)

Die Set-Verwaltung ist ein eigener Dialog mit zwei Ansichten, zwischen denen man umschalten kann: **Form** und **JSON**. Beide bearbeiten dasselbe Set.

**Form-Ansicht** (Hauptweg; gut durchdacht, schnell bedienbar):
- Links: Liste der Sets mit den Aktionen New, Duplicate, Delete, Copy, Paste und Export/Import (Datei).
- Rechts: Set-Kopf mit Name, Zielserver (Dropdown aus SSH-Servern), Proxy Jump (Optionen
  „use server default“, „direct“ oder „custom chain“ mit sortierbarer Server-Liste) und Auto-Start-Checkbox.
- Darunter eine **Tabelle der Einträge**: eine Zeile pro Forward mit Spalten Enabled, Name, Type
  (L/R/D), Bind address, Bind port, Target host, Target port.
  - Bearbeitung direkt in der Zelle, Tab/Enter springt weiter.
  - Bei `dynamic` sind die Target-Spalten deaktiviert.
  - Zeilenaktionen: Add, Duplicate, Delete, Copy, Paste, Umsortieren per Drag.
  - Mehrfachauswahl (Shift/Ctrl-Klick) zum Kopieren, Löschen oder Einfügen mehrerer Einträge.
  - Shortcuts in der Tabelle: `Ctrl+C`, `Ctrl+V`, `Ctrl+D` (duplizieren), `Del`.
- **Validierung live** pro Feld:
  - Ports im Bereich 1–65535
  - doppelte Bind-Ports innerhalb des Sets und über aktive Sets hinweg (Warnung)
  - Pflichtfelder je Typ
  - Ports < 1024 erzeugen einen Hinweis (unter Linux sind Root-Rechte nötig)
- Änderungen an einem **aktiven** Set wirken erst nach erneutem Aktivieren. Der Dialog zeigt dann „Restart set to apply“ mit Button.

**JSON-Ansicht:**
- CodeMirror-Editor mit dem JSON des aktuell gewählten Sets, Schema-Validierung, Fehlermarkierung und Autocomplete.
- Bei ungültigem JSON ist kein Speichern möglich, und der Fehler wird inline angezeigt.
- Zusätzlich gibt es eine Option „Edit all sets as JSON“, die die gesamte `forward-sets.json` im Editor öffnet.

**Copy/Paste:**
- Sets und Einträge werden als JSON in die System-Zwischenablage kopiert, damit sie zwischen Sets, Fenstern und Installationen austauschbar sind (Format siehe 4.2).
- Paste erkennt automatisch, ob die Zwischenablage ein Set, einen Eintrag oder eine Liste von Einträgen enthält.

---

## 8. Terminal

- Der Terminal-Emulator ist xterm.js mit Rendering wie in einem klassischen Terminal (Monospace, Farbschema, kein Schnickschnack).
- Unicode, 256 Farben und Truecolor, Maus-Reporting (für vim, htop, tmux), Bracketed Paste, klickbare URLs (Ctrl+Klick).
- Resize wird an die SSH-Sitzung bzw. das PTY weitergegeben (Window-Change).
- Rechtsklick fügt ein (konfigurierbar). Markieren kopiert **nicht** automatisch (konfigurierbar).
- **Sitzungsabbruch:** kein Auto-Reconnect. Im Tab erscheint „Connection closed – press Enter to reconnect“, und der Tab bleibt offen.
  Ein Reconnect öffnet eine neue Sitzung im selben Tab.

### 8.1 Tastenkombinationen (Defaults, alle über `settings.json` änderbar)

| Shortcut | Funktion |
|---|---|
| `Ctrl+C` | SIGINT, wird **immer** ans Terminal durchgereicht (auch bei Markierung) |
| `Ctrl+Shift+C` | Markierten Text kopieren |
| `Ctrl+Shift+V` | Einfügen |
| `Ctrl+Shift+T` | Neuer Tab (öffnet Quick-Connect) |
| `Ctrl+Shift+W` | Tab schließen |
| `Ctrl+Shift+N` | Neues Fenster |
| `Ctrl+PgUp` / `Ctrl+PgDn` | Vorheriger / nächster Tab |
| `Ctrl+Shift+PgUp` / `Ctrl+Shift+PgDn` | Tab nach links / rechts verschieben |
| `Alt+1` … `Alt+9` | Zu Tab 1…9 springen |
| `Ctrl+Plus` / `Ctrl+Minus` / `Ctrl+0` | Zoom größer / kleiner / zurücksetzen |
| `Ctrl+Shift+F` | Suche im Scrollback |
| `Ctrl+Shift+B` | Server-Sidebar ein/aus |
| `Ctrl+Shift+O` | Quick-Connect |

Alle übrigen Tasten, z. B. `Ctrl+D`, `Ctrl+Z`, `Ctrl+R`, `Ctrl+L`, `Alt+…` und die Funktionstasten, gehen unverändert ans Terminal.

---

## 9. Tabs & Fenster

- Jede Sitzung (SSH oder lokal) läuft in einem eigenen Tab. Der Tab-Titel ist standardmäßig der Servername; per Doppelklick lässt er sich umbenennen.
- Tabs lassen sich per Drag umsortieren.
- **Tear-off:** Zieht man einen Tab aus der Tab-Leiste heraus, entsteht ein neues Fenster an der Mausposition mit derselben, weiterlaufenden Sitzung (kein Reconnect, Scrollback bleibt erhalten).
- Zieht man einen Tab in die Tab-Leiste eines **anderen** Fensters, wird er dorthin verschoben.
- Tab-Kontextmenü: Rename, Duplicate (neue Sitzung zum selben Server), Move to new window, Close, Close others.
- Mehrere unabhängige Fenster sind möglich, auch auf mehreren Monitoren. Fensterposition und -größe des letzten Fensters werden gemerkt.
- Wird ein Fenster mit offenen Sitzungen geschlossen, kommt eine **Rückfrage**.
- Beim Schließen des letzten Fensters wird die App beendet, und alle Tunnel werden geschlossen (siehe 7.1).
- **Keine** Wiederherstellung von Sitzungen oder Tabs beim App-Start.

---

## 10. Serverliste & Navigation

- **Sidebar** links, einklappbar (`Ctrl+Shift+B`):
  - Ordner/Gruppen, Suchfeld oben, lokale Shells als eigene Gruppe „Local“
  - Doppelklick öffnet einen Tab
  - Kontextmenü: Connect, Connect in new window, Edit, Duplicate, Delete, Proxy Jump an/aus
  - Server lassen sich per Drag in Ordner verschieben
- **Quick-Connect** (`Ctrl+Shift+O`, auch `Ctrl+Shift+T`):
  - Overlay mit Fuzzy-Suche über alle Server
  - Enter öffnet einen Tab
  - Eingabe von `user@host[:port]` ohne gespeicherten Server ermöglicht eine Ad-hoc-Verbindung, mit Option „Save“
- Ein Leerzustand ohne Tabs zeigt die Serverliste bzw. einen Hinweis auf Quick-Connect.

---

## 11. Außer Scope für v1

- SFTP / Dateibrowser
- Split-Panes innerhalb eines Tabs
- Broadcast-Eingabe an mehrere Sitzungen
- Session-Logging
- X11-Forwarding
- Sync zwischen Installationen (außer JSON-Copy/Paste/Export)
- Tray-Icon / Hintergrundbetrieb ohne Fenster
- Verschlüsselung gespeicherter Passwörter / Master-Passwort
- Code-Signing der Windows-exe
- macOS, ARM-Builds
- Settings-Formular-UI (Settings nur über `settings.json`)
- Wiederherstellung von Sitzungen beim Start

---

## 12. Vorgeschlagene Meilensteine

1. **Gerüst:** Electron und TypeScript, Main/Preload/Renderer, IPC-Schicht, Config-Store mit Datei-Watcher und JSON-Schemas, lokale `dist`-Scripts (früh einen AppImage-Build testen, damit `node-pty` und die Packaging-Probleme sofort sichtbar werden).
2. **Terminal-Kern:** lokale Shell in xterm.js, Shortcuts, `settings.json` mit Live-Reload.
3. **SSH:** Verbindungen, alle Auth-Methoden, known_hosts, keyboard-interactive, Reconnect-Overlay.
4. **Serververwaltung:** Sidebar, Dialoge, Ordner, Quick-Connect, Import aus `~/.ssh/config`.
5. **Proxy Jumps:** Kette, Schalter, Validierung.
6. **Tabs & Fenster:** Umsortieren, Tear-off, Verschieben zwischen Fenstern, Rückfragen.
7. **Port Forwarding:** Engine (L/R/D, Jumps, Teilfehler, Backoff, Auto-Start), Tunnel-Popup.
8. **Set-Verwaltung:** Form-Ansicht, JSON-Ansicht, Copy/Paste, Export/Import.
9. **Lokale Release-Builds:** `dist:linux` und `dist:win` erzeugen lauffähige Artefakte, mit Smoke-Test auf beiden Plattformen.
10. GitHub Actions und Releases (siehe 3.1).

---

## 13. Abnahmekriterien (Auszug)

- Die portable `.exe` startet auf einem frischen Windows 10/11 ohne Installation. Die `AppImage` startet auf einem aktuellen Ubuntu/Fedora.
- Zwei SSH-Tabs und ein lokaler Tab laufen parallel. Ein Tab lässt sich in ein neues Fenster ziehen und wieder zurück, ohne dass die Sitzung abbricht.
- `Ctrl+C` beendet `ping` auf dem Remote-Host. `Ctrl+Shift+C/V` kopieren und fügen ein. vim, htop und tmux funktionieren korrekt.
- Eine Verbindung über eine Jump-Kette mit 2 Hops funktioniert. Ist der Schalter deaktiviert, wird direkt verbunden.
- Ein Set mit -L, -R und -D über einen Jump-Host lässt sich über das Popup aktivieren:
  - Alle Ports funktionieren.
  - Ein belegter Port führt zu einem Fehler nur bei diesem Eintrag.
  - Wird die Verbindung gekappt, folgt ein Reconnect mit Backoff.
  - Ein falsches Passwort beim Start führt zu „error“ ohne Retry.
- Ein Set lässt sich als JSON kopieren und in einer anderen Installation einfügen. Der Server wird dabei per Name aufgelöst.
- Eine Änderung in `settings.json` (z. B. `fontSize`) wirkt sofort in allen offenen Tabs.
- Ein geänderter Host-Key blockiert die Verbindung.

---

## 14. Umsetzungsstand (v1)

Alle Punkte aus Abschnitt 1–13 sind umgesetzt.
Prüfung: `npm test` (Unit- und Integrationstests gegen SSH-Server im Testprozess), `npm run typecheck`, `npm run lint`,
Smoke-Tests der gebauten App und der AppImage (siehe README, „Smoke testing“).

Präzisierungen und Abweichungen gegenüber dem Text oben:
- **JSON-Ansicht eines Sets** nutzt das portable Austauschformat: Server und Jump-Hosts werden per **Name** referenziert
  (Auflösung beim Speichern bzw. Einfügen erst per id, dann per Name). In `forward-sets.json` stehen weiterhin ids.
- **Auth-Reihenfolge (auto):** Agent, Keys (verschlüsselte Keys fragen nach der Passphrase), gespeichertes Passwort,
  Passwort-Abfrage, keyboard-interactive. Mehrere Agents werden nacheinander probiert (Windows: OpenSSH-Pipe, dann Pageant).
- **Handshake-Timeout** (`ssh.connectTimeout`) pausiert, solange ein Dialog (Host-Key, Passwort, 2FA) offen ist.
- **Tunnel-Reconnects** zeigen nie Dialoge. Braucht ein Reconnect eine Eingabe, schlägt er fehl und wird mit Backoff erneut versucht.
- **Tear-off:** Ein Tab, der außerhalb jeder Tab-Leiste losgelassen wird (auch im eigenen, z. B. maximierten Fenster), öffnet ein
  neues Fenster an der Mausposition. Beim Loslassen auf der Tab-Leiste eines anderen Fensters wandert der Tab dorthin.
- **Automatisch erkannte Shells** bekommen stabile, aus dem Shell-Typ abgeleitete UUIDs.
- **Zusätzliche Dateien im Config-Ordner:** `window-state.json` (letzte Fensterposition) und `chromium/` (Electron-Cache).
- **Windows-`.exe`:** Der Build ist nur auf Windows möglich (in CI auf `windows-latest`). Ein Cross-Build von Linux aus bricht an `cpu-features` ab.

---

## 15. Erweiterungen nach v1

### 15.1 Ordner und Unterordner
- Ordner lassen sich beliebig tief verschachteln (`folders[].parentId` in `servers.json`).
- Verschieben geht auf zwei Wegen:
  - **Drag & Drop** in der Sidebar: Server und Ordner auf einen Ordner ziehen. Auf „Ungrouped“, „Local“ oder eine freie Fläche ziehen verschiebt auf die oberste Ebene.
  - **„Move to…“** im Kontextmenü: Dialog mit Ordnerbaum und Filter.
- **Mehrfachauswahl** mit Strg/Shift-Klick (Strg+A wählt alles). Mehrere Einträge lassen sich gemeinsam verschieben oder löschen.
- Ein Ordner kann nicht in sich selbst oder einen eigenen Unterordner verschoben werden. Zyklen in `servers.json` werden beim Speichern abgelehnt.
- Wird ein Ordner gelöscht, wandern seine Server und Unterordner eine Ebene nach oben.
- Kontextmenü eines Ordners: New server here, New subfolder, Rename, Move to, Delete.

### 15.2 Export/Import der gesamten Konfiguration
- Hauptmenü → „Export configuration…“ / „Import configuration…“.
- Datei `*.ptbackup`, technisch ein normales ZIP mit `manifest.json`, `servers.json`, `forward-sets.json` und `settings.json`.
- **Ohne Passwort** werden gespeicherte Passwörter und Passphrasen nicht exportiert.
- **Mit Passwort** liegen sie zusätzlich in `secrets.enc` (AES-256-GCM, Schlüssel per scrypt). Die übrigen Dateien bleiben lesbar und enthalten keine Secrets.
- Import-Modi:
  - **Merge:** Ordner, Server und Sets werden über ihre id aktualisiert oder hinzugefügt. Lokale Einträge und lokale Einstellungen bleiben, lokale Passwörter bleiben, sofern das Backup keine eigenen mitbringt.
  - **Replace:** Das Backup wird zur gesamten Konfiguration. Tunnel von Sets, die es danach nicht mehr gibt, werden gestoppt.
- Ein Backup mit Secrets kann auch ohne Passwort importiert werden, dann ohne Secrets.
- Private Keys und `known_hosts` sind nicht Teil des Exports.

### 15.3 Port Forwarding: Bedienung
- **Proxy Jump im Set:** Checkbox „Use proxy jump“, dann den gespeicherten Server wählen, über den gesprungen wird. „+ hop“ hängt weitere Jump-Hosts an.
  - Checkbox aus: direkte Verbindung.
  - Hat das Set keine eigene Angabe, gilt die Jump-Konfiguration des Zielservers. Die UI zeigt dann „as configured for the server“.
- **Tunnel-Übersicht** (Button ⇄ in der Tab-Leiste), ähnlich MobaSSHTunnel:
  - pro Set ein Start/Stop-Button, Status und Route (z. B. „bastion → app-server“)
  - Umschalter **auto-start** und **reconnect**, die sofort gespeichert werden
  - „Start all“ / „Stop all“
- **Auto-Reconnect pro Set** (`autoReconnect`, Standard an):
  - Aus: Bricht die Verbindung ab, geht das Set auf „error: Connection lost“ und wird nicht neu verbunden.
  - Das Umschalten wirkt sofort, auch bei laufenden Sets.
- Set-Verwaltung: Start/Stop-Buttons in der Set-Liste. Unter „Options“ stehen „Start when the app starts“ und „Reconnect automatically“.

---

## 16. Desktop-Integration und Kommandozeile

### 16.1 Icon
- App-Icon `>_` (`build/icon.svg`, daraus `build/icons/*.png` und `build/icon.ico`).
- Unter Windows steckt das Icon in der `.exe`, Taskbar und Jump-List nutzen es (AppUserModelID `dev.prime-terminal.app`).
- Unter Linux bekommen die Fenster das Icon direkt. GNOME ordnet das Dock-Icon über den Launcher zu (WM_CLASS `prime-terminal` = `StartupWMClass`).

### 16.2 Integration der portablen Builds (Menü ≡ → „Desktop integration…“)
Beim **ersten Start der AppImage bzw. portablen exe** fragt die App einmal nach. Dort lässt sich die Integration auch später ändern oder entfernen.
Alle erzeugten Dateien werden protokolliert (`desktop-integration.json`) und bei jedem Start neu geschrieben, falls die Datei verschoben wurde. Ebenso nach jeder Änderung an der Serverliste.

**Linux (GNOME u. a.)**, alles im Benutzerprofil:
- `~/.local/share/applications/prime-terminal.desktop` mit Icon in `~/.local/share/icons/hicolor`. Die App erscheint in der Suche (Super-Taste) und im Dock mit dem richtigen Icon.
- **Rechtsklick auf den Launcher:** „New Window“ und bis zu 20 Server zum direkten Verbinden.
- **Server in der GNOME-Suche (optional, GNOME Search Provider):** Nach Super + Suchbegriff erscheinen passende Server als Treffer *unter Prime Terminal*, wie bei „Einstellungen“ oder „Dateien“. Es entstehen keine eigenen Apps pro Server.
  - Gesucht wird in Name, Host, User und Ordnerpfad. Enter oder Klick verbindet.
  - „Suche in App starten“ öffnet Prime Terminal mit dem Suchbegriff (Quick-Connect).
  - Umsetzung: ein kleines Python-Skript (`~/.local/share/prime-terminal/search-provider.py`, braucht python3-gi). Es startet per D-Bus-Aktivierung nur bei Bedarf, liest `servers.json` bei jeder Suche und beendet sich nach 60 s Leerlauf. Electron startet dafür nicht.
  - Registrierung: GNOME lädt `*.search-provider.ini` nur aus seinen `XDG_DATA_DIRS`. Liegt dort ein beschreibbarer Ordner im Home (z. B. `~/.local/share/flatpak/exports/share`), geht es ohne Passwort. Sonst fragt die App beim Aktivieren **einmal** nach dem Administrator-Passwort (`pkexec`, Ziel `/usr/local/share/gnome-shell/search-providers`).
- **`primeterminal`-Befehl (optional):** `~/.local/bin/primeterminal`.
- Server-Launcher und App-Ordner einer früheren Zwischenversion werden automatisch entfernt.

**Windows**:
- Startmenü-Eintrag „Prime Terminal“, damit die Windows-Suche die App findet.
- `primeterminal.cmd` in `%LOCALAPPDATA%\Microsoft\WindowsApps` (standardmäßig im PATH).
- Die **Jump-List** (Rechtsklick aufs Taskbar-Icon) zeigt die Server zum direkten Verbinden, auch ohne Integration.

### 16.3 Kommandozeile
```
primeterminal [--new-window] [ziel ...]
  ziel = Servername | Host | user@host[:port] | --id=<server-id>
```
- **Auflösung:**
  1. Name (ohne Groß/Klein-Unterscheidung)
  2. `--id`
  3. Host bzw. `user@host:port` eines gespeicherten Servers
  4. sonst Ad-hoc-Verbindung wie bei `ssh`
- Mehrdeutige Namen oder Unsinn öffnen Quick-Connect mit vorbelegter Suche und Hinweis.
- **Eine Instanz:** Läuft die App schon, öffnet ein weiterer Aufruf die Tabs im aktiven Fenster (`--new-window` in einem neuen Fenster). Ohne Ziel öffnet ein weiterer Start ein neues Fenster.
- `primeterminal --help` gibt die Hilfe aus.
