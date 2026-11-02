import { useState } from 'react'
import { Modal } from './Modal'

interface Props {
  title: string
  label: string
  initial?: string
  onSubmit: (value: string) => void
  onClose: () => void
}

export function TextInputDialog({ title, label, initial = '', onSubmit, onClose }: Props) {
  const [v, setV] = useState(initial)
  const submit = () => {
    if (!v.trim()) return
    onSubmit(v.trim())
    onClose()
  }
  return (
    <Modal
      center
      title={title}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!v.trim()}>
            OK
          </button>
        </>
      }
    >
      <div className="form" style={{ gridTemplateColumns: '1fr' }}>
        <label>{label}</label>
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()} />
      </div>
    </Modal>
  )
}
