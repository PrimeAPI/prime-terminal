import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  title: ReactNode
  onClose: () => void
  /** Enter (outside textareas/editors) submits */
  onSubmit?: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'normal' | 'medium' | 'wide'
  center?: boolean
}

export function Modal({ title, onClose, onSubmit, children, footer, size = 'normal', center }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const body = ref.current?.querySelector('.body')
    const first =
      ref.current?.querySelector<HTMLElement>('[autofocus]') ??
      body?.querySelector<HTMLElement>('input, select, textarea, button') ??
      ref.current?.querySelector<HTMLElement>('footer button.primary, footer button')
    first?.focus()
    return () => prev?.focus?.()
  }, [])

  return (
    <div
      className={'backdrop' + (center ? ' center' : '')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className={'dialog' + (size !== 'normal' ? ' ' + size : '')}
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Enter' && onSubmit && !e.shiftKey) {
            const t = e.target as HTMLElement
            if (t.tagName === 'TEXTAREA' || t.closest('.cm-editor') || t.tagName === 'BUTTON') return
            e.preventDefault()
            onSubmit()
          }
        }}
      >
        <header>{title}</header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}
