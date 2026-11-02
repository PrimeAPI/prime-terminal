import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: { outDir: 'out/main' }
  },
  preload: {
    build: { outDir: 'out/preload' }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: { input: resolve('src/renderer/index.html') }
    },
    plugins: [react()]
  }
})
