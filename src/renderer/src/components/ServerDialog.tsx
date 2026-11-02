import { useState } from 'react'
import type { AuthMethod, LocalServer, Server, ServersDoc, SshServer } from '../../../shared/types'
import { validateServerJumpChain } from '../../../shared/proxy'
import { newId } from '../../../shared/ids'
import { pt } from '../lib/api'
import { Modal } from './Modal'

interface Props {
  doc: ServersDoc
  /** existing server to edit, or a template for a new one */
  server: Server | null
  defaultFolderId?: string
  onClose: () => void
  onSaved: (s: Server) => void
}

function splitArgs(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}
const joinArgs = (args: string[] | undefined) => (args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')

export function ServerDialog({ doc, server, defaultFolderId, onClose, onSaved }: Props) {
  const isNew = !server || !doc.servers.some((s) => s.id === server.id)
  const [type, setType] = useState<'ssh' | 'local'>(server?.type ?? 'ssh')
  const ssh = server?.type === 'ssh' ? server : null
  const local = server?.type === 'local' ? server : null
  const [name, setName] = useState(server?.name ?? '')
  const [folderId, setFolderId] = useState(server?.folderId ?? defaultFolderId ?? '')
  const [host, setHost] = useState(ssh?.host ?? '')
  const [port, setPort] = useState(String(ssh?.port ?? 22))
  const [username, setUsername] = useState(ssh?.username ?? '')
  const [method, setMethod] = useState<AuthMethod>(ssh?.auth.method ?? 'auto')
  const [password, setPassword] = useState(ssh?.auth.password ?? '')
  const [keyPath, setKeyPath] = useState(ssh?.auth.keyPath ?? '')
  const [passphrase, setPassphrase] = useState(ssh?.auth.keyPassphrase ?? '')
  const [showSecrets, setShowSecrets] = useState(false)
  const [jumpEnabled, setJumpEnabled] = useState(ssh?.proxyJump?.enabled ?? false)
  const [chain, setChain] = useState<string[]>(ssh?.proxyJump?.chain ?? [])
  const [shell, setShell] = useState(local?.shell ?? '')
  const [args, setArgs] = useState(joinArgs(local?.args))
  const [cwd, setCwd] = useState(local?.cwd ?? '')
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const id = server?.id ?? newId()
  const sshCandidates = doc.servers.filter((s): s is SshServer => s.type === 'ssh' && s.id !== id)
  const portNum = Number(port)
  const problems: Record<string, string> = {}
  if (!name.trim()) problems.name = 'Name is required'
  if (type === 'ssh') {
    if (!host.trim()) problems.host = 'Host is required'
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) problems.port = 'Port must be 1–65535'
    if (!username.trim()) problems.username = 'User is required'
    const chainProblems = validateServerJumpChain(id, chain, doc)
    if (chainProblems.length) problems.chain = chainProblems[0]
  } else if (!shell.trim()) problems.shell = 'Shell path is required'

  const cls = (k: string) => (touched && problems[k] ? 'invalid' : '')

  const save = async () => {
    setTouched(true)
    if (Object.keys(problems).length) return
    let s: Server
    if (type === 'ssh') {
      const auth: SshServer['auth'] = { method }
      if (password && (method === 'password' || method === 'auto')) auth.password = password
      if (keyPath && (method === 'key' || method === 'auto')) auth.keyPath = keyPath
      if (passphrase && (method === 'key' || method === 'auto')) auth.keyPassphrase = passphrase
      s = {
        id,
        type: 'ssh',
        name: name.trim(),
        host: host.trim(),
        port: portNum,
        username: username.trim(),
        auth,
        ...(folderId ? { folderId } : {}),
        ...(chain.length || jumpEnabled ? { proxyJump: { enabled: jumpEnabled && chain.length > 0, chain } } : {})
      }
    } else {
      const l: LocalServer = { id, type: 'local', name: name.trim(), shell: shell.trim() }
      const a = splitArgs(args)
      if (a.length) l.args = a
      if (cwd.trim()) l.cwd = cwd.trim()
      if (folderId) l.folderId = folderId
      if (local?.autoDetected) l.autoDetected = true
      if (local?.hidden) l.hidden = true
      s = l
    }
    const next: ServersDoc = {
      ...doc,
      servers: isNew ? [...doc.servers, s] : doc.servers.map((x) => (x.id === id ? s : x))
    }
    const r = await pt.config.saveServers(next)
    if (!r.ok) return setError(r.error)
    onSaved(s)
    onClose()
  }

  const moveHop = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= chain.length) return
    const c = [...chain]
    ;[c[i], c[j]] = [c[j], c[i]]
    setChain(c)
  }

  return (
    <Modal
      title={isNew ? 'New server' : `Edit ${server?.name}`}
      onClose={onClose}
      onSubmit={() => void save()}
      size="medium"
      footer={
        <>
          {error && <span className="error-text">{error}</span>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <label>Type</label>
        <div className="segmented">
          <button className={type === 'ssh' ? 'on' : ''} onClick={() => setType('ssh')} disabled={!isNew}>
            SSH
          </button>
          <button className={type === 'local' ? 'on' : ''} onClick={() => setType('local')} disabled={!isNew}>
            Local shell
          </button>
        </div>
        <label>Name</label>
        <input className={cls('name')} value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="web-01" />
        <label>Folder</label>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">(none)</option>
          {doc.folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>

        {type === 'ssh' ? (
          <>
            <h4>Connection</h4>
            <label>Host</label>
            <div className="row">
              <input className={cls('host')} value={host} onChange={(e) => setHost(e.target.value)} placeholder="host.example.com" />
              <span className="hint">Port</span>
              <input className={cls('port')} style={{ width: 70, flex: 'none' }} value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
            <label>User</label>
            <input className={cls('username')} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />

            <h4>Authentication</h4>
            <label>Method</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as AuthMethod)}>
              <option value="auto">Automatic (agent, ~/.ssh keys, password)</option>
              <option value="password">Password</option>
              <option value="key">SSH key</option>
              <option value="agent">SSH agent only</option>
            </select>
            {(method === 'password' || method === 'auto') && (
              <>
                <label>Password</label>
                <div className="row">
                  <input
                    type={showSecrets ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={method === 'auto' ? 'optional – asked when needed' : 'leave empty to be asked'}
                  />
                  <button className="icon" title="Show/hide" onClick={() => setShowSecrets((v) => !v)}>
                    {showSecrets ? '◉' : '○'}
                  </button>
                </div>
              </>
            )}
            {(method === 'key' || method === 'auto') && (
              <>
                <label>Key file</label>
                <div className="row">
                  <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="default: ~/.ssh/id_ed25519, id_ecdsa, id_rsa" />
                  <button
                    onClick={async () => {
                      const p = await pt.config.pickKeyFile()
                      if (p) setKeyPath(p)
                    }}
                  >
                    Browse…
                  </button>
                </div>
                <label>Passphrase</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="optional – asked when needed"
                />
              </>
            )}
            <div className="full hint">Passwords and passphrases are stored in plain text in servers.json.</div>

            <h4>Proxy jump</h4>
            <label>Enabled</label>
            <label style={{ color: 'inherit' }}>
              <input type="checkbox" checked={jumpEnabled} onChange={(e) => setJumpEnabled(e.target.checked)} /> Connect through
              the jump hosts below
            </label>
            <label>Jump hosts</label>
            <div className="chain-list">
              {chain.map((hid, i) => {
                const h = doc.servers.find((s) => s.id === hid)
                return (
                  <div className="chain-item" key={hid + i}>
                    <span>
                      {i + 1}. {h ? h.name : <span className="error-text">missing server</span>}
                      {h?.type === 'ssh' && <span className="hint"> {h.username}@{h.host}</span>}
                    </span>
                    <button className="icon" onClick={() => moveHop(i, -1)} disabled={i === 0} title="Move up">
                      ↑
                    </button>
                    <button className="icon" onClick={() => moveHop(i, 1)} disabled={i === chain.length - 1} title="Move down">
                      ↓
                    </button>
                    <button className="icon" onClick={() => setChain(chain.filter((_, j) => j !== i))} title="Remove">
                      ✕
                    </button>
                  </div>
                )
              })}
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    setChain([...chain, e.target.value])
                    setJumpEnabled(true)
                  }
                }}
              >
                <option value="">Add jump host…</option>
                {sshCandidates
                  .filter((s) => !chain.includes(s.id))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.username}@{s.host})
                    </option>
                  ))}
              </select>
              {touched && problems.chain && <span className="error-text">{problems.chain}</span>}
              <span className="hint">First entry is the first hop. Jump hosts use their own saved credentials.</span>
            </div>
          </>
        ) : (
          <>
            <h4>Local shell</h4>
            <label>Shell</label>
            <input className={cls('shell')} value={shell} onChange={(e) => setShell(e.target.value)} placeholder={pt.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/bash'} />
            <label>Arguments</label>
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder='e.g. -l or -d "Ubuntu"' />
            <label>Start directory</label>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" />
          </>
        )}
        {touched && Object.keys(problems).length > 0 && (
          <div className="full error-text">{Object.values(problems)[0]}</div>
        )}
      </div>
    </Modal>
  )
}
