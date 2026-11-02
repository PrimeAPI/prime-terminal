import { useEffect, useState } from 'react'
import type { PromptRequest, PromptResponse } from '../../../shared/types'
import { pt } from '../lib/api'
import { Modal } from './Modal'

interface Item {
  id: string
  req: PromptRequest
}

export function PromptHost() {
  const [queue, setQueue] = useState<Item[]>([])

  useEffect(() => {
    const off1 = pt.prompts.onPrompt((id, req) => setQueue((q) => [...q, { id, req }]))
    const off2 = pt.prompts.onCancel((id) => setQueue((q) => q.filter((i) => i.id !== id)))
    pt.prompts.ready()
    return () => {
      off1()
      off2()
    }
  }, [])

  const current = queue[0]
  if (!current) return null
  const answer = (r: PromptResponse) => {
    pt.prompts.respond(current.id, r)
    setQueue((q) => q.slice(1))
  }
  const { req } = current
  if (req.kind === 'hostKey') return <HostKeyPrompt key={current.id} req={req} answer={answer} />
  if (req.kind === 'secret') return <SecretPrompt key={current.id} req={req} answer={answer} />
  return <KbdPrompt key={current.id} req={req} answer={answer} />
}

type P<K extends PromptRequest['kind']> = { req: Extract<PromptRequest, { kind: K }>; answer: (r: PromptResponse) => void }

function HostKeyPrompt({ req, answer }: P<'hostKey'>) {
  const target = req.port === 22 ? req.host : `[${req.host}]:${req.port}`
  if (req.status === 'changed') {
    return (
      <Modal
        center
        title={<span style={{ color: 'var(--err)' }}>Host key has changed</span>}
        onClose={() => answer({ kind: 'hostKey', trust: false })}
        footer={
          <button className="primary" onClick={() => answer({ kind: 'hostKey', trust: false })}>
            Close
          </button>
        }
      >
        <div className="danger-box">
          The host key for <b>{target}</b> does not match the key stored in <span className="mono">~/.ssh/known_hosts</span>.
          Someone could be intercepting the connection (man-in-the-middle), or the server was reinstalled.
        </div>
        <p>The server now presents this {req.keyType} key:</p>
        <div className="hostkey-fp">{req.fingerprint}</div>
        <p className="hint">
          The connection was blocked. If the change is expected, remove the old entry from known_hosts (e.g.{' '}
          <span className="mono">ssh-keygen -R {target}</span>) and connect again.
        </p>
      </Modal>
    )
  }
  return (
    <Modal
      center
      title="Unknown host"
      onClose={() => answer({ kind: 'hostKey', trust: false })}
      onSubmit={() => answer({ kind: 'hostKey', trust: true })}
      footer={
        <>
          <button onClick={() => answer({ kind: 'hostKey', trust: false })}>Cancel</button>
          <button className="primary" autoFocus onClick={() => answer({ kind: 'hostKey', trust: true })}>
            Trust and save
          </button>
        </>
      }
    >
      <p>
        The authenticity of host <b>{target}</b> can&apos;t be established. {req.keyType} key fingerprint:
      </p>
      <div className="hostkey-fp">{req.fingerprint}</div>
      <p className="hint">Trusting adds the key to ~/.ssh/known_hosts.</p>
    </Modal>
  )
}

function SecretPrompt({ req, answer }: P<'secret'>) {
  const [value, setValue] = useState('')
  const [save, setSave] = useState(false)
  const submit = () => answer({ kind: 'secret', value, save })
  return (
    <Modal
      center
      title={`${req.secret === 'password' ? 'Password' : 'Key passphrase'} – ${req.serverName}`}
      onClose={() => answer(null)}
      onSubmit={submit}
      footer={
        <>
          <button onClick={() => answer(null)}>Cancel</button>
          <button className="primary" onClick={submit}>
            OK
          </button>
        </>
      }
    >
      <div className="form">
        <div className="full">{req.message}</div>
        <input className="full" type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        {req.allowSave && (
          <label className="full" style={{ color: 'inherit' }}>
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />{' '}
            Save {req.secret === 'password' ? 'password' : 'passphrase'} (stored in plain text)
          </label>
        )}
      </div>
    </Modal>
  )
}

function KbdPrompt({ req, answer }: P<'keyboardInteractive'>) {
  const [answers, setAnswers] = useState<string[]>(() => req.prompts.map(() => ''))
  const submit = () => answer({ kind: 'keyboardInteractive', answers })
  return (
    <Modal
      center
      title={`${req.name || 'Authentication'} – ${req.serverName}`}
      onClose={() => answer(null)}
      onSubmit={submit}
      footer={
        <>
          <button onClick={() => answer(null)}>Cancel</button>
          <button className="primary" onClick={submit}>
            OK
          </button>
        </>
      }
    >
      {req.instructions && <p style={{ whiteSpace: 'pre-wrap' }}>{req.instructions}</p>}
      <div className="form">
        {req.prompts.map((p, i) => (
          <div className="full" key={i}>
            <div style={{ marginBottom: 4 }}>{p.prompt}</div>
            <input
              style={{ width: '100%' }}
              type={p.echo ? 'text' : 'password'}
              autoFocus={i === 0}
              value={answers[i]}
              onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </div>
        ))}
      </div>
    </Modal>
  )
}
