import { useState } from 'react'
import type { BackupInfo } from '../../../preload/api'
import { pt } from '../lib/api'
import { Modal } from './Modal'

interface Props {
  mode: 'export' | 'import'
  onClose: () => void
  notify: (msg: string, error?: boolean) => void
}

export function BackupDialog({ mode, onClose, notify }: Props) {
  return mode === 'export' ? <ExportDialog onClose={onClose} notify={notify} /> : <ImportDialog onClose={onClose} notify={notify} />
}

function ExportDialog({ onClose, notify }: Omit<Props, 'mode'>) {
  const [withSecrets, setWithSecrets] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mismatch = withSecrets && pw2 !== '' && pw !== pw2
  const canExport = !withSecrets || (pw.length > 0 && pw === pw2)

  const run = async () => {
    if (!canExport) return
    const r = await pt.backup.export(withSecrets ? pw : undefined)
    if (!r) return
    if (!r.ok) return setError(r.error)
    notify(`Configuration exported to ${r.path}`)
    onClose()
  }

  return (
    <Modal
      center
      title="Export configuration"
      onClose={onClose}
      onSubmit={() => void run()}
      footer={
        <>
          {error && <span className="error-text">{error}</span>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canExport} onClick={() => void run()}>
            Export…
          </button>
        </>
      }
    >
      <p>
        Exports servers, folders, port forwarding sets and settings into one <span className="mono">.ptbackup</span> file (a regular
        ZIP archive).
      </p>
      <div className="form" style={{ gridTemplateColumns: '130px 1fr' }}>
        <label />
        <label style={{ color: 'inherit' }}>
          <input type="checkbox" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} /> Include saved passwords and
          passphrases
        </label>
        {withSecrets && (
          <>
            <label>Password</label>
            <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
            <label>Repeat</label>
            <input type="password" className={mismatch ? 'invalid' : ''} value={pw2} onChange={(e) => setPw2(e.target.value)} />
            <div className="full hint">
              Passwords are stored encrypted (AES-256) with this password. Everything else in the file stays readable.
            </div>
          </>
        )}
        {!withSecrets && <div className="full hint">Saved passwords and passphrases are not included.</div>}
        <div className="full hint">Private key files and known_hosts are not part of the export.</div>
      </div>
    </Modal>
  )
}

function ImportDialog({ onClose, notify }: Omit<Props, 'mode'>) {
  const [file, setFile] = useState<{ token: string; path: string; info: BackupInfo } | null>(null)
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pick = async () => {
    const r = await pt.backup.pick()
    if (!r) return
    if (!r.ok) return setError(r.error)
    setError(null)
    setFile(r)
  }

  const run = async () => {
    if (!file) return
    if (importMode === 'replace' && !confirm('Replace your current servers, folders, forwarding sets and settings with the backup?')) return
    setBusy(true)
    const r = await pt.backup.import(file.token, { mode: importMode, password: pw || undefined })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    notify(`Configuration imported (${importMode})${file.info.hasSecrets && !pw ? ' – without passwords' : ''}`)
    onClose()
  }

  return (
    <Modal
      center
      title="Import configuration"
      onClose={onClose}
      onSubmit={() => void (file ? run() : pick())}
      footer={
        <>
          {error && <span className="error-text">{error}</span>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!file || busy} onClick={() => void run()}>
            Import
          </button>
        </>
      }
    >
      <div className="form">
        <label>File</label>
        <div className="row">
          <input readOnly value={file?.path ?? ''} placeholder="Choose a .ptbackup file" />
          <button onClick={() => void pick()} autoFocus>
            Browse…
          </button>
        </div>
        {file && (
          <>
            <label>Contents</label>
            <div>
              {file.info.counts.servers} servers, {file.info.counts.folders} folders, {file.info.counts.sets} forwarding sets
              <div className="hint">created {new Date(file.info.createdAt).toLocaleString()}</div>
            </div>
            <label>Mode</label>
            <div>
              <label style={{ color: 'inherit', display: 'block' }}>
                <input type="radio" checked={importMode === 'merge'} onChange={() => setImportMode('merge')} /> Merge – add new items, update
                items that already exist, keep my settings
              </label>
              <label style={{ color: 'inherit', display: 'block', marginTop: 4 }}>
                <input type="radio" checked={importMode === 'replace'} onChange={() => setImportMode('replace')} /> Replace – use the backup
                as my whole configuration
              </label>
            </div>
            {file.info.hasSecrets && (
              <>
                <label>Password</label>
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="to import saved passwords (optional)" />
                <div className="full hint">This backup contains encrypted passwords. Leave empty to import without them.</div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
