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
  const [serverLaunchers, setServerLaunchers] = useState(true)
  const [cliCommand, setCliCommand] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void pt.desktop.get().then((s) => {
      setSt(s)
      setServerLaunchers(s.serverLaunchers)
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
    const r = await pt.desktop.apply({ serverLaunchers, cliCommand })
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
          ? 'Adds Prime Terminal to the Start menu, so Windows search finds it, and puts your servers in the taskbar jump list.'
          : 'Adds Prime Terminal with its icon to the app menu, so the search (Super key) finds it and the dock shows the right icon. Right-click the launcher to connect to a server directly.'}
      </p>
      <div className="form" style={{ gridTemplateColumns: '1fr' }}>
        <label style={{ color: 'inherit' }}>
          <input type="checkbox" checked={serverLaunchers} onChange={(e) => setServerLaunchers(e.target.checked)} /> Find servers in the{' '}
          {win ? 'Windows' : 'desktop'} search
          <div className="hint" style={{ marginLeft: 22 }}>
            {win
              ? 'One Start-menu shortcut per server (folder "Prime Terminal\\Servers"). Typing a server name connects directly.'
              : 'One launcher per server, grouped in the app-grid folder “Prime Terminal servers”. Typing a server name or host connects directly.'}
          </div>
        </label>
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
