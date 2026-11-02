// Nested folders for the server list.

import type { Folder, Server, ServersDoc } from './types'

export interface FolderNode {
  folder: Folder
  children: FolderNode[]
  servers: Server[]
}

export interface FolderTree {
  folders: FolderNode[]
  /** servers without (valid) folder */
  servers: Server[]
}

export function folderTree(doc: ServersDoc, servers: Server[] = doc.servers): FolderTree {
  const ids = new Set(doc.folders.map((f) => f.id))
  const nodes = new Map<string, FolderNode>(doc.folders.map((f) => [f.id, { folder: f, children: [], servers: [] }]))
  const roots: FolderNode[] = []
  for (const f of doc.folders) {
    const node = nodes.get(f.id)!
    const parent = f.parentId && f.parentId !== f.id && ids.has(f.parentId) ? nodes.get(f.parentId)! : null
    // guard against cycles in hand-edited files: attach to root if the parent chain loops
    if (parent && !isDescendant(f.parentId!, f.id, doc)) parent.children.push(node)
    else roots.push(node)
  }
  const top: Server[] = []
  for (const s of servers) {
    const n = s.folderId ? nodes.get(s.folderId) : undefined
    if (n) n.servers.push(s)
    else top.push(s)
  }
  return { folders: roots, servers: top }
}

/** true if `id` is `ancestorId` or lies (transitively) inside it */
export function isDescendant(id: string, ancestorId: string, doc: ServersDoc): boolean {
  const byId = new Map(doc.folders.map((f) => [f.id, f]))
  const seen = new Set<string>()
  let cur: string | undefined = id
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    cur = byId.get(cur)?.parentId
  }
  return false
}

export function folderPath(id: string, doc: ServersDoc): string {
  const byId = new Map(doc.folders.map((f) => [f.id, f]))
  const parts: string[] = []
  const seen = new Set<string>()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id)) {
    parts.unshift(cur.name)
    seen.add(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return parts.join(' / ')
}

function withParent<T extends { parentId?: string; folderId?: string }>(o: T, key: 'parentId' | 'folderId', id: string | null): T {
  const copy = { ...o }
  if (id) copy[key] = id
  else delete copy[key]
  return copy
}

export function moveServers(doc: ServersDoc, serverIds: string[], folderId: string | null): ServersDoc {
  const set = new Set(serverIds)
  return { ...doc, servers: doc.servers.map((s) => (set.has(s.id) ? withParent(s, 'folderId', folderId) : s)) }
}

export function moveFolder(doc: ServersDoc, id: string, parentId: string | null): ServersDoc {
  if (parentId && isDescendant(parentId, id, doc)) throw new Error('A folder cannot be moved into itself')
  return { ...doc, folders: doc.folders.map((f) => (f.id === id ? withParent(f, 'parentId', parentId) : f)) }
}

export function deleteFolder(doc: ServersDoc, id: string): ServersDoc {
  const folder = doc.folders.find((f) => f.id === id)
  if (!folder) return doc
  const up = folder.parentId ?? null
  return {
    folders: doc.folders.filter((f) => f.id !== id).map((f) => (f.parentId === id ? withParent(f, 'parentId', up) : f)),
    servers: doc.servers.map((s) => (s.folderId === id ? withParent(s, 'folderId', up) : s))
  }
}
