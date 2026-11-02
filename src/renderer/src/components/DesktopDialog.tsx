import { useEffect, useState } from 'react'
import type { DesktopIntegrationStatus } from '../../../preload/api'
import { pt } from '../lib/api'
import { Modal } from './Modal'

interface Props {
  firstStart?: boolean
  onClose: () => void
  notify: (msg: string, error?: boolean) => void
}

/** Add/remove app-menu & search integration, server launchers and the `primeterminal` command. */
export function DesktopDialog({ firstStart, onClose, notify }: Props) {
  const [st, setSt] = useState<DesktopIntegrationStatus | null>(null)
  const [searchProvider, setSearchProvider] = useState(true)
  const [cliCommand, setCliCommand] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void pt.desktop.get().then((s) => {
      setSt(s)
      setSearchProvider(s.searchProvider)
      setCliCommand(s.cliCommand)
    })
  }, [])

  const close = () => {
    pt.desktop.dismiss()
    onClose()
  }

  if (!st) return null
  const win = st.platform === 'win32'

  const apply = async () => {
    setBusy(true)
    const r = await pt.desktop.apply({ searchProvider: searchProvider && st.searchProviderSupport !== 'unavailable', cliCommand })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    notify(win ? 'Added to the Start menu' : 'Added to the app menu and search')
    onClose()
  }
  const remove = async () => {
    setBusy(true)
    const r = await pt.desktop.remove()
    setBusy(false)
    if (!r.ok) return setError(r.error)
    notify('Desktop integration removed')
    onClose()
  }

  if (st.installed) {
    return (
      <Modal center title="Desktop integration" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
        <p>
          Prime Terminal is installed as a package. The app menu entry, the server results in the GNOME search and the{' '}
          <span className="mono">primeterminal</span> command are already set up.
        </p>
      </Modal>
    )
  }

  if (!st.supported) {
    return (
      <Modal center title="Desktop integration" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
        <p>Desktop integration is available on Linux and Windows.</p>
      </Modal>
    )
  }

  return (
    <Modal
      center
      title={firstStart ? 'Add Prime Terminal to your desktop?' : 'Desktop integration'}
      onClose={close}
      onSubmit={() => void apply()}
      footer={
        <>
          {error && <span className="error-text">{error}</span>}
          <span className="spacer" />
          {st.enabled && (
            <button className="danger" disabled={busy} onClick={() => void remove()}>
              Remove
            </button>
          )}
          <button onClick={close}>{firstStart ? 'Not now' : 'Cancel'}</button>
          <button className="primary" disabled={busy} onClick={() => void apply()}>
            {st.enabled ? 'Update' : 'Add'}
          </button>
        </>
      }
    >
      <p>
        {win
          ? 'Adds Prime Terminal to the Start menu, so Windows search finds it. Right-click the taskbar icon to connect to a server directly.'
          : 'Adds Prime Terminal with its icon to the app menu, so the search (Super key) finds it and the dock shows the right icon. Right-click the launcher to connect to a server directly.'}
      </p>
      <div className="form" style={{ gridTemplateColumns: '1fr' }}>
        {!win && (
          <label style={{ color: 'inherit', opacity: st.searchProviderSupport === 'unavailable' ? 0.6 : 1 }}>
            <input
              type="checkbox"
              disabled={st.searchProviderSupport === 'unavailable'}
              checked={searchProvider && st.searchProviderSupport !== 'unavailable'}
              onChange={(e) => setSearchProvider(e.target.checked)}
            />{' '}
            Show my servers in the GNOME search
            <div className="hint" style={{ marginLeft: 22 }}>
              Type a server name, host or folder after pressing Super – matching servers appear as results of Prime Terminal, Enter
              connects. {st.searchProviderNote}
            </div>
          </label>
        )}
        <label style={{ color: 'inherit' }}>
          <input type="checkbox" checked={cliCommand} onChange={(e) => setCliCommand(e.target.checked)} /> Add the{' '}
          <span className="mono">primeterminal</span> command
          <div className="hint" style={{ marginLeft: 22 }}>
            <span className="mono">primeterminal web-01</span> or <span className="mono">primeterminal user@host</span> opens a tab (in the
            running window if there is one).{' '}
            {win ? 'Installed to %LOCALAPPDATA%\\Microsoft\\WindowsApps.' : 'Installed to ~/.local/bin.'}
          </div>
        </label>
        <div className="hint">
          Launchers start <span className="mono">{st.command.join(' ')}</span>
          {st.portable ? ' – they are updated automatically when you move the file and start it again.' : ''}
        </div>
        {firstStart && <div className="hint">You can change this later in the menu (≡ → Desktop integration).</div>}
      </div>
    </Modal>
  )
}
