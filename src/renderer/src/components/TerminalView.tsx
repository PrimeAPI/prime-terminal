import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { Settings } from '../../../shared/types'
import { pt } from '../lib/api'
import { scheme } from '../lib/themes'

// one IPC subscription for all terminals of this window
const sinks = new Map<string, (data: string) => void>()
pt.sessions.onData((id, data) => sinks.get(id)?.(data))

export interface TerminalHandle {
  copy(): void
  paste(): void
  find(): void
  focus(): void
}

interface Props {
  sessionId: string
  active: boolean
  settings: Settings
  zoom: number
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView({ sessionId, active, settings, zoom }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)

  const paste = () => {
    void pt.ui.clipboardRead().then((text) => {
      if (text) termRef.current?.paste(text)
    })
  }

  useImperativeHandle(ref, () => ({
    copy() {
      const sel = termRef.current?.getSelection()
      if (sel) pt.ui.clipboardWrite(sel)
    },
    paste,
    find() {
      setSearchOpen(true)
      setTimeout(() => searchInput.current?.select(), 0)
    },
    focus() {
      termRef.current?.focus()
    }
  }))

  // create terminal once
  useEffect(() => {
    const s = settingsRef.current.terminal
    const term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      scrollback: s.scrollback,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      theme: scheme(s.colorScheme).terminal,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) pt.ui.openExternal(uri)
      })
    )
    term.open(host.current!)
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    // GPU renderer when available; fall back to the DOM renderer on failure/context loss
    void import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        if (!termRef.current) return
        try {
          const gl = new WebglAddon()
          gl.onContextLoss(() => gl.dispose())
          term.loadAddon(gl)
        } catch {
          // DOM renderer stays active
        }
      })
      .catch(() => {})

    let ready = false
    const early: string[] = []
    sinks.set(sessionId, (d) => (ready ? term.write(d) : early.push(d)))

    try {
      fit.fit()
    } catch {
      // not visible yet
    }
    void pt.sessions.attach(sessionId, term.cols, term.rows).then(({ snapshot }) => {
      if (snapshot) term.write(snapshot)
      for (const d of early) term.write(d)
      early.length = 0
      ready = true
    })

    term.onData((d) => pt.sessions.write(sessionId, d))
    term.onBinary((d) => pt.sessions.write(sessionId, d))
    term.onResize(({ cols, rows }) => pt.sessions.resize(sessionId, cols, rows))
    term.onSelectionChange(() => {
      if (settingsRef.current.terminal.copyOnSelect) {
        const sel = term.getSelection()
        if (sel) pt.ui.clipboardWrite(sel)
      }
    })

    const el = host.current!
    const onContext = (e: MouseEvent) => {
      e.preventDefault()
      if (settingsRef.current.terminal.rightClick === 'paste') return paste()
      void pt.ui
        .contextMenu([
          { id: 'copy', label: 'Copy', enabled: term.hasSelection(), accelerator: settingsRef.current.keybindings.copy },
          { id: 'paste', label: 'Paste', accelerator: settingsRef.current.keybindings.paste },
          { id: 'all', label: 'Select all' },
          { type: 'separator' },
          { id: 'find', label: 'Find…', accelerator: settingsRef.current.keybindings.find },
          { id: 'clear', label: 'Clear scrollback' }
        ])
        .then((r) => {
          if (r === 'copy') pt.ui.clipboardWrite(term.getSelection())
          else if (r === 'paste') paste()
          else if (r === 'all') term.selectAll()
          else if (r === 'find') setSearchOpen(true)
          else if (r === 'clear') term.clear()
          term.focus()
        })
    }
    el.addEventListener('contextmenu', onContext)

    let pending: number | null = null
    const ro = new ResizeObserver(() => {
      if (pending) cancelAnimationFrame(pending)
      pending = requestAnimationFrame(() => {
        pending = null
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          try {
            fit.fit()
          } catch {
            // ignore
          }
        }
      })
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      el.removeEventListener('contextmenu', onContext)
      sinks.delete(sessionId)
      pt.sessions.detach(sessionId)
      termRef.current = null
      term.dispose()
    }
  }, [sessionId])

  // live settings + zoom
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const s = settings.terminal
    term.options.fontFamily = s.fontFamily
    term.options.fontSize = Math.max(6, s.fontSize + zoom)
    term.options.scrollback = s.scrollback
    term.options.cursorStyle = s.cursorStyle
    term.options.cursorBlink = s.cursorBlink
    term.options.theme = scheme(s.colorScheme).terminal
    try {
      fitRef.current?.fit()
    } catch {
      // ignore
    }
  }, [settings, zoom])

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      termRef.current?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [active])

  const runSearch = (forward: boolean) => {
    if (!query) return
    const opts = { decorations: undefined, caseSensitive: false }
    if (forward) searchRef.current?.findNext(query, opts)
    else searchRef.current?.findPrevious(query, opts)
  }

  return (
    <div className={'terminal-pane' + (active ? '' : ' hidden')} style={{ background: scheme(settings.terminal.colorScheme).terminal.background }}>
      {searchOpen && (
        <div className="searchbar">
          <input
            ref={searchInput}
            autoFocus
            placeholder="Find"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (e.target.value) searchRef.current?.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(!e.shiftKey)
              if (e.key === 'Escape') {
                setSearchOpen(false)
                searchRef.current?.clearDecorations()
                termRef.current?.clearSelection()
                termRef.current?.focus()
              }
              e.stopPropagation()
            }}
          />
          <button className="icon" title="Previous (Shift+Enter)" onClick={() => runSearch(false)}>
            ↑
          </button>
          <button className="icon" title="Next (Enter)" onClick={() => runSearch(true)}>
            ↓
          </button>
          <button
            className="icon"
            title="Close (Esc)"
            onClick={() => {
              setSearchOpen(false)
              termRef.current?.focus()
            }}
          >
            ✕
          </button>
        </div>
      )}
      <div ref={host} style={{ height: '100%' }} />
    </div>
  )
})
