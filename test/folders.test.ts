import { describe, expect, it } from 'vitest'
import { deleteFolder, folderPath, folderTree, isDescendant, moveFolder, moveServers } from '../src/shared/folders'
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
