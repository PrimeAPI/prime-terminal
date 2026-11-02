import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, Menu } from 'electron'
import { PrimeApp } from './app'
import { APP_USER_MODEL_ID } from './desktop/integration'
import { parseLaunchArgs, USAGE } from '../shared/launch'

const here = fileURLToPath(new URL('.', import.meta.url))
// Inside the snap the launcher points XDG_CONFIG_HOME into the snap's own data folder; use the real
// ~/.config so apt, snap and AppImage share one configuration.
const configDir = process.env.SNAP
  ? join(homedir(), '.config', 'prime-terminal')
  : join(app.getPath('appData'), 'prime-terminal')
// keep Chromium's own data next to the config instead of a second "Prime Terminal" folder
app.setPath('userData', join(configDir, 'chromium'))
app.setName('Prime Terminal')

if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)

/** User arguments of a command line (drops the executable and, in development, the app path). */
function userArgs(argv: string[]): string[] {
  const rest = argv.slice(1)
  if (!app.isPackaged) {
    const i = rest.findIndex((a) => !a.startsWith('-'))
    if (i >= 0) rest.splice(i, 1)
  }
  return rest
}

const launch = parseLaunchArgs(userArgs(process.argv))
let primeApp: PrimeApp | null = null

if (launch.help) {
  process.stdout.write(USAGE)
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  // another instance is running: it receives our arguments via 'second-instance'
  app.exit(0)
} else {
  app.on('second-instance', (_e, argv) => {
    const args = parseLaunchArgs(userArgs(argv))
    if (args.help) return
    primeApp?.handleLaunch(args, true)
  })

  app.whenReady().then(() => {
    // no application menu: all shortcuts belong to the terminal / our own keybindings
    Menu.setApplicationMenu(null)
    primeApp = new PrimeApp(configDir, join(here, '../preload/index.mjs'), (win) => {
      if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
      else void win.loadFile(join(here, '../renderer/index.html'))
    })
    primeApp.start()
    primeApp.handleLaunch(launch, false)
  })
}

app.on('window-all-closed', () => app.quit())

let shuttingDown = false
app.on('before-quit', (e) => {
  if (!primeApp || shuttingDown) return
  shuttingDown = true
  e.preventDefault()
  const done = () => app.quit()
  primeApp.shutdown().then(done, done)
  setTimeout(done, 2000)
})

// Development smoke test: PT_SMOKE_SCREENSHOT=out.png [PT_SMOKE_JS=script.js] runs the optional
// script in the first window, captures all windows and quits.
// Never active in packaged builds unless explicitly allowed (it executes a script from disk).
if (process.env.PT_SMOKE_SCREENSHOT && (!app.isPackaged || process.env.PT_ALLOW_SMOKE === '1')) {
  const shot = process.env.PT_SMOKE_SCREENSHOT
  app.whenReady().then(async () => {
    const { BrowserWindow } = await import('electron')
    const { readFileSync, writeFileSync } = await import('node:fs')
    await new Promise((r) => setTimeout(r, 2500))
    const win = BrowserWindow.getAllWindows()[0]
    if (process.env.PT_SMOKE_JS) {
      try {
        const result = await win.webContents.executeJavaScript(readFileSync(process.env.PT_SMOKE_JS, 'utf8'))
        console.log('SMOKE_RESULT', JSON.stringify(result))
      } catch (e) {
        console.log('SMOKE_ERROR', String(e))
      }
    }
    const wins = BrowserWindow.getAllWindows()
    for (let i = 0; i < wins.length; i++) {
      const img = await wins[i].webContents.capturePage()
      writeFileSync(i === 0 ? shot : shot.replace(/\.png$/, `-${i}.png`), img.toPNG())
    }
    console.log('SMOKE_WINDOWS', wins.length)
    if (process.env.PT_SMOKE_CLOSE === 'window') for (const w of wins) w.close()
    else app.quit()
  })
}
