import { describe, expect, it } from 'vitest'
import { deleteFolder, folderPath, folderTree, isDescendant, moveFolder, moveServers, placeItemsChecked, type DropTarget } from '../src/shared/folders'
import type { ServersDoc } from '../src/shared/types'

const doc = (): ServersDoc => ({
  folders: [
    { id: 'prod', name: 'Production' },
    { id: 'web', name: 'Web', parentId: 'prod' },
    { id: 'eu', name: 'EU', parentId: 'web' },
    { id: 'dev', name: 'Dev' }
  ],
  servers: [
    { id: 'a', type: 'ssh', name: 'a', host: 'a', port: 22, username: 'u', auth: { method: 'auto' }, folderId: 'eu' },
    { id: 'b', type: 'ssh', name: 'b', host: 'b', port: 22, username: 'u', auth: { method: 'auto' }, folderId: 'web' },
    { id: 'c', type: 'ssh', name: 'c', host: 'c', port: 22, username: 'u', auth: { method: 'auto' } }
  ]
})

describe('folder tree', () => {
  it('builds a nested tree with servers attached to their folder', () => {
    const t = folderTree(doc())
    expect(t.folders.map((f) => f.folder.id)).toEqual(['prod', 'dev'])
    const web = t.folders[0].children[0]
    expect(web.folder.id).toBe('web')
    expect(web.servers.map((s) => s.id)).toEqual(['b'])
    expect(web.children[0].servers.map((s) => s.id)).toEqual(['a'])
    expect(t.servers.map((s) => s.id)).toEqual(['c'])
  })

  it('treats folders with unknown parents and servers with unknown folders as top level', () => {
    const d = doc()
    d.folders.push({ id: 'orphan', name: 'Orphan', parentId: 'gone' })
    d.servers.push({ id: 'x', type: 'ssh', name: 'x', host: 'x', port: 22, username: 'u', auth: { method: 'auto' }, folderId: 'gone' })
    const t = folderTree(d)
    expect(t.folders.map((f) => f.folder.id)).toContain('orphan')
    expect(t.servers.map((s) => s.id)).toContain('x')
  })

  it('renders the path of a folder', () => {
    expect(folderPath('eu', doc())).toBe('Production / Web / EU')
  })

  it('detects descendants', () => {
    expect(isDescendant('eu', 'prod', doc())).toBe(true)
    expect(isDescendant('prod', 'eu', doc())).toBe(false)
  })
})

describe('moving', () => {
  it('moves several servers into a folder or to the top level', () => {
    const d = moveServers(doc(), ['a', 'c'], 'dev')
    expect(d.servers.filter((s) => s.folderId === 'dev').map((s) => s.id)).toEqual(['a', 'c'])
    const top = moveServers(d, ['a'], null)
    expect(top.servers.find((s) => s.id === 'a')).not.toHaveProperty('folderId')
  })

  it('moves a folder with its content and rejects cycles', () => {
    const d = moveFolder(doc(), 'web', 'dev')
    expect(d.folders.find((f) => f.id === 'web')!.parentId).toBe('dev')
    expect(folderPath('eu', d)).toBe('Dev / Web / EU')
    expect(() => moveFolder(doc(), 'prod', 'eu')).toThrow(/into itself/)
    expect(() => moveFolder(doc(), 'prod', 'prod')).toThrow(/into itself/)
    expect(moveFolder(doc(), 'web', null).folders.find((f) => f.id === 'web')).not.toHaveProperty('parentId')
  })

  it('deleting a folder moves its servers and subfolders one level up', () => {
    const d = deleteFolder(doc(), 'web')
    expect(d.folders.map((f) => f.id)).toEqual(['prod', 'eu', 'dev'])
    expect(d.folders.find((f) => f.id === 'eu')!.parentId).toBe('prod')
    expect(d.servers.find((s) => s.id === 'b')!.folderId).toBe('prod')
    const top = deleteFolder(doc(), 'prod')
    expect(top.folders.find((f) => f.id === 'web')).not.toHaveProperty('parentId')
  })
})

describe('reordering', () => {
  // server ids without prefix are servers, 'f:'-prefixed are folders
  const keyOf = (x: string) => (x.startsWith('f:') || x.startsWith('s:') ? x : ['prod', 'web', 'eu', 'dev'].includes(x) ? `f:${x}` : `s:${x}`)
  const placeItems = (d: ServersDoc, items: string[], t: DropTarget) => placeItemsChecked(d, items.map(keyOf), t).doc
  const ids = (d: ServersDoc, kind: 'servers' | 'folders') => d[kind].map((x) => x.id)

  it('puts servers before or after another server and takes over its folder', () => {
    const d = placeItems(doc(), ['c'], { position: 'before', key: 's:b' })
    expect(ids(d, 'servers')).toEqual(['a', 'c', 'b'])
    expect(d.servers.find((s) => s.id === 'c')!.folderId).toBe('web')
    const after = placeItems(doc(), ['a'], { position: 'after', key: 's:c' })
    expect(ids(after, 'servers')).toEqual(['b', 'c', 'a'])
    expect(after.servers.find((s) => s.id === 'a')).not.toHaveProperty('folderId')
  })

  it('keeps the relative order of several moved servers', () => {
    const d = placeItems(doc(), ['c', 'a'], { position: 'before', key: 's:b' })
    expect(ids(d, 'servers')).toEqual(['a', 'c', 'b'])
  })

  it('reorders folders among their siblings and re-parents them', () => {
    const d = placeItems(doc(), ['dev'], { position: 'before', key: 'f:prod' })
    expect(ids(d, 'folders')).toEqual(['dev', 'prod', 'web', 'eu'])
    const nested = placeItems(doc(), ['dev'], { position: 'after', key: 'f:eu' })
    expect(nested.folders.find((f) => f.id === 'dev')!.parentId).toBe('web')
  })

  it('moves items into a folder (at the end) or to the top level', () => {
    const d = placeItems(doc(), ['c'], { position: 'into', folderId: 'eu' })
    expect(d.servers.find((s) => s.id === 'c')!.folderId).toBe('eu')
    expect(ids(d, 'servers').at(-1)).toBe('c')
    const top = placeItems(doc(), ['web'], { position: 'into', folderId: null })
    expect(top.folders.find((f) => f.id === 'web')).not.toHaveProperty('parentId')
  })

  it('treats a server dropped next to a folder as moving into that folder\'s parent', () => {
    const d = placeItems(doc(), ['c'], { position: 'after', key: 'f:web' })
    expect(d.servers.find((s) => s.id === 'c')!.folderId).toBe('prod')
  })

  it('refuses to put a folder inside itself and reports it', () => {
    const r = placeItemsChecked(doc(), ['f:prod'], { position: 'before', key: 'f:eu' })
    expect(r.skipped).toBe(1)
    expect(r.doc.folders.find((f) => f.id === 'prod')).not.toHaveProperty('parentId')
  })
})
