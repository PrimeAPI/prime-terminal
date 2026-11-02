import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { jsonSchema } from 'codemirror-json-schema'
import type { JSONSchema7 } from 'json-schema'

interface Props {
  value: string
  onChange: (v: string) => void
  schema?: object
  onSave?: () => void
}

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--input-bg)', color: 'var(--fg)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-2)', color: 'var(--fg-dim)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 35%, transparent) !important'
  },
  '.cm-tooltip': { backgroundColor: 'var(--bg-3)', border: '1px solid var(--border)', color: 'var(--fg)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' }
})

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--accent)' },
  { tag: tags.string, color: 'var(--ok)' },
  { tag: tags.number, color: 'var(--warn)' },
  { tag: [tags.bool, tags.null], color: 'var(--err)' },
  { tag: tags.invalid, color: 'var(--err)', textDecoration: 'underline' }
])

/** CodeMirror JSON editor with schema validation, completion and hover docs. */
export function JsonEditor({ value, onChange, schema, onSave }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([
            indentWithTab,
            {
              key: 'Mod-s',
              run: () => {
                onSaveRef.current?.()
                return true
              }
            }
          ]),
          ...(schema ? jsonSchema(schema as JSONSchema7) : [json()]),
          theme,
          syntaxHighlighting(highlight),
          EditorState.tabSize.of(2),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          })
        ]
      })
    })
    view.current = v
    v.focus()
    return () => v.destroy()
  }, [schema])

  // external value changes (e.g. switching sets)
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
    }
  }, [value])

  return <div className="json-host" ref={host} onKeyDown={(e) => e.stopPropagation()} />
}
