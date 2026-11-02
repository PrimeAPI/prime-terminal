import { useEffect, useState } from 'react'
import type { ConfigFileKind } from '../../../shared/types'
import { serversSchema, setsSchema, settingsSchema } from '../../../shared/schemas'
import { pt } from '../lib/api'
import { JsonEditor } from './JsonEditor'
import { Modal } from './Modal'

const META: Record<ConfigFileKind, { title: string; schema: object }> = {
  settings: { title: 'settings.json', schema: settingsSchema },
  servers: { title: 'servers.json', schema: serversSchema },
  sets: { title: 'forward-sets.json', schema: setsSchema }
}

interface Props {
  kind: ConfigFileKind
  path?: string
  onClose: () => void
}

/** Raw JSON editing of a config file (validated on save, applied live). */
export function ConfigEditorDialog({ kind, path, onClose }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [original, setOriginal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void pt.config.readText(kind).then((t) => {
      setText(t)
      setOriginal(t)
    })
  }, [kind])

  const dirty = text !== null && text !== original
  const save = async () => {
    if (text === null) return
    const r = await pt.config.saveText(kind, text)
    if (!r.ok) {
      setError(r.error)
      setSaved(false)
      return
    }
    setError(null)
    setOriginal(text)
    setSaved(true)
  }
  const close = () => {
    if (dirty && !confirm('Discard unsaved changes?')) return
    onClose()
  }

  return (
    <Modal
      title={
        <>
          {META[kind].title}
          {path && <span className="hint mono" style={{ fontWeight: 400 }}>{path}</span>}
        </>
      }
      size="medium"
      onClose={close}
      footer={
        <>
          {error ? (
            <span className="error-text">{error}</span>
          ) : saved && !dirty ? (
            <span className="hint">Saved – changes are applied immediately.</span>
          ) : (
            <span className="hint">Ctrl+S to save</span>
          )}
          <span className="spacer" />
          <button onClick={close}>Close</button>
          <button className="primary" disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div style={{ height: '100%', display: 'flex' }}>
        {text !== null && (
          <JsonEditor
            value={text}
            schema={META[kind].schema}
            onChange={(v) => {
              setText(v)
              setSaved(false)
            }}
            onSave={() => void save()}
          />
        )}
      </div>
    </Modal>
  )
}
