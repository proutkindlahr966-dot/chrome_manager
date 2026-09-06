import { useEffect, useRef } from 'react'
import { useUiStore } from '@/stores/ui-store'
import { cn } from '@/lib/utils'

export function ConfirmDialog(): JSX.Element | null {
  const confirm = useUiStore((s) => s.confirm)
  const resolveConfirm = useUiStore((s) => s.resolveConfirm)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!confirm) return
    confirmBtnRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        resolveConfirm(false)
        return
      }
      if (e.key === 'Enter' && document.activeElement === confirmBtnRef.current) {
        e.preventDefault()
        resolveConfirm(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, resolveConfirm])

  if (!confirm) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Đóng"
        className="absolute inset-0 bg-ink/45 backdrop-blur-[2px]"
        onClick={() => resolveConfirm(false)}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={confirm.description ? 'confirm-desc' : undefined}
        className="relative z-10 w-full max-w-md animate-fade-up rounded-2xl border border-line bg-surface-overlay p-5 shadow-panel"
      >
        <h2 id="confirm-title" className="font-display text-lg font-semibold text-ink">
          {confirm.title}
        </h2>
        {confirm.description ? (
          <p id="confirm-desc" className="mt-2 whitespace-pre-line text-sm text-ink-muted">
            {confirm.description}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => resolveConfirm(false)}
          >
            {confirm.cancelLabel ?? 'Hủy'}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={cn(confirm.danger ? 'btn-danger' : 'btn-primary')}
            onClick={() => resolveConfirm(true)}
          >
            {confirm.confirmLabel ?? 'Xác nhận'}
          </button>
        </div>
      </div>
    </div>
  )
}
