/** Score a subsequence match; higher is better, null = no match. */
function score(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx === 0) return 1000 - t.length
  if (idx > 0) return 500 - idx - t.length / 100
  let ti = 0
  let s = 0
  let last = -2
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return null
    s += found === last + 1 ? 5 : 1
    last = found
    ti = found + 1
  }
  return s - t.length / 100
}

export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string): T[] {
  const q = query.trim()
  if (!q) return items.slice()
  const scored: { item: T; s: number; i: number }[] = []
  items.forEach((item, i) => {
    const s = score(q, text(item))
    if (s !== null) scored.push({ item, s, i })
  })
  scored.sort((a, b) => b.s - a.s || a.i - b.i)
  return scored.map((x) => x.item)
}

export interface AdhocTarget {
  username?: string
  host: string
  port?: number
}

/** Parse "user@host[:port]" or "host[:port]" typed into quick connect. */
export function parseAdhocTarget(input: string): AdhocTarget | null {
  const m = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/.exec(input.trim())
  if (!m) return null
  const host = m[2].replace(/^\[|\]$/g, '')
  const out: AdhocTarget = { host }
  if (m[1]) out.username = m[1]
  if (m[3]) {
    const port = Number(m[3])
    if (port < 1 || port > 65535) return null
    out.port = port
  }
  return out
}
