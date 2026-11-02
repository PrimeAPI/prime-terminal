import { join } from 'node:path'
import Ajv, { type ValidateFunction } from 'ajv'
import { defaultServersDoc, defaultSetsDoc, defaultSettings, withSettingsDefaults } from '../../shared/defaults'
import { serversSchema, setsSchema, settingsSchema } from '../../shared/schemas'
import { validateServerJumpChain } from '../../shared/proxy'
import { isDescendant } from '../../shared/folders'
import type { ConfigFileKind, ForwardSetsDoc, ServersDoc, Settings } from '../../shared/types'
import { JsonFileStore } from './jsonStore'

const ajv = new Ajv({ allErrors: false, strict: false })

function describe(v: ValidateFunction): string {
  const e = v.errors?.[0]
  if (!e) return 'Invalid document'
  return `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`
}

function schemaValidator(schema: object, extra?: (v: any) => string | null) {
  const v = ajv.compile(schema)
  return (value: unknown) => {
    if (!v(value)) return describe(v)
    return extra ? extra(value) : null
  }
}

function serversSemantics(doc: ServersDoc): string | null {
  const folderIds = new Set<string>()
  for (const f of doc.folders) {
    if (folderIds.has(f.id)) return `Duplicate folder id ${f.id}`
    folderIds.add(f.id)
    if (f.parentId && isDescendant(f.parentId, f.id, doc)) return `Folder "${f.name}" is inside itself`
  }
  const ids = new Set<string>()
  for (const s of doc.servers) {
    if (ids.has(s.id)) return `Duplicate server id ${s.id}`
    ids.add(s.id)
  }
  for (const s of doc.servers) {
    if (s.type === 'ssh' && s.proxyJump) {
      const p = validateServerJumpChain(s.id, s.proxyJump.chain, doc)
      if (p.length) return `Server "${s.name}": ${p[0]}`
    }
  }
  return null
}

function setsSemantics(doc: ForwardSetsDoc): string | null {
  const ids = new Set<string>()
  for (const s of doc.sets) {
    if (ids.has(s.id)) return `Duplicate set id ${s.id}`
    ids.add(s.id)
  }
  return null
}

/** Validators for the three config documents (error message or null). */
export const validateServersDoc = schemaValidator(serversSchema, serversSemantics)
export const validateSetsDoc = schemaValidator(setsSchema, setsSemantics)
export const validateSettingsDoc = schemaValidator(settingsSchema)
export const normalizeSettings = (v: unknown) => withSettingsDefaults(v as Partial<Settings>)

export function createConfigStores(dir: string) {
  const servers = new JsonFileStore<ServersDoc>(join(dir, 'servers.json'), {
    defaults: defaultServersDoc,
    validate: validateServersDoc
  })
  const sets = new JsonFileStore<ForwardSetsDoc>(join(dir, 'forward-sets.json'), {
    defaults: defaultSetsDoc,
    validate: validateSetsDoc
  })
  const settings = new JsonFileStore<Settings>(join(dir, 'settings.json'), {
    defaults: defaultSettings,
    validate: validateSettingsDoc,
    normalize: normalizeSettings
  })
  const byKind: Record<ConfigFileKind, JsonFileStore<any>> = { servers, sets, settings }
  return {
    servers,
    sets,
    settings,
    byKind,
    loadAll() {
      servers.load()
      sets.load()
      settings.load()
    },
    watchAll() {
      servers.watch()
      sets.watch()
      settings.watch()
    },
    closeAll() {
      servers.close()
      sets.close()
      settings.close()
    }
  }
}

export type ConfigStores = ReturnType<typeof createConfigStores>
