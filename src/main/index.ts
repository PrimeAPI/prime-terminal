import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, Menu } from 'electron'
import { PrimeApp } from './app'

const here = fileURLToPath(new URL('.', import.meta.url))
const configDir = join(app.getPath('appData'), 'prime-terminal')
// keep Chromium's own data next to the config instead of a second "Prime Terminal" folder
app.setPath('userData', join(configDir, 'chromium'))
app.setName('Prime Terminal')

let primeApp: PrimeApp | null = null

app.whenReady().then(() => {
  // no application menu: all shortcuts belong to the terminal / our own keybindings
  Menu.setApplicationMenu(null)
  primeApp = new PrimeApp(configDir, join(here, '../preload/index.mjs'), (win) => {
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void win.loadFile(join(here, '../renderer/index.html'))
  })
  primeApp.start()
})

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
if (process.env.PT_SMOKE_SCREENSHOT) {
  const shot = process.env.PT_SMOKE_SCREENSHOT
  app.whenReady().then(async () => {
    const { BrowserWindow } = await import('electron')
    const { readFileSync, writeFileSync } = await import('node:fs')
    console.log('SMOKE_START')
    await new Promise((r) => setTimeout(r, 2500))
    console.log('SMOKE_WAITED', BrowserWindow.getAllWindows().length)
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
