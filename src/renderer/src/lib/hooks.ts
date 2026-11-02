import { useEffect, useState } from 'react'
import type { ConfigSnapshot, TunnelSetStatus, WindowTabsState } from '../../../shared/types'
import { pt } from './api'

export function useConfig(): ConfigSnapshot | null {
  const [cfg, setCfg] = useState<ConfigSnapshot | null>(null)
  useEffect(() => {
    let alive = true
    void pt.config.get().then((c) => alive && setCfg(c))
    const off = pt.config.onChange(setCfg)
    return () => {
      alive = false
      off()
    }
  }, [])
  return cfg
}

export function useTabs(): WindowTabsState | null {
  const [s, setS] = useState<WindowTabsState | null>(null)
  useEffect(() => {
    let alive = true
    void pt.tabs.get().then((t) => alive && setS(t))
    const off = pt.tabs.onState(setS)
    return () => {
      alive = false
      off()
    }
  }, [])
  return s
}

export function useTunnels(): Record<string, TunnelSetStatus> {
  const [m, setM] = useState<Record<string, TunnelSetStatus>>({})
  useEffect(() => {
    let alive = true
    void pt.tunnels.status().then((list) => {
      if (!alive) return
      setM((prev) => {
        const next = { ...prev }
        for (const s of list) next[s.setId] = s
        return next
      })
    })
    const off = pt.tunnels.onStatus((s) => setM((prev) => ({ ...prev, [s.setId]: s })))
    return () => {
      alive = false
      off()
    }
  }, [])
  return m
}

/** Re-render every second (for "reconnecting in Ns" countdowns). */
export function useTicker(active: boolean): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setN((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  return n
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  const set = (nv: T) => {
    setV(nv)
    try {
      localStorage.setItem(key, JSON.stringify(nv))
    } catch {
      // ignore
    }
  }
  return [v, set]
}
