import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useUiStore, type ToastTone } from '@/stores/ui-store'
import { cn } from '@/lib/utils'

const icons: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle
}

const toneClass: Record<ToastTone, string> = {
  info: 'border-line',
  success: 'border-success/30',
  error: 'border-danger/30',
  warning: 'border-warning/30'
}

export function ToastHost(): JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  const dismissToast = useUiStore((s) => s.dismissToast)

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((item) => {
        const Icon = icons[item.tone]
        return (
          <div
            key={item.id}
            className={cn(
              'pointer-events-auto animate-fade-up rounded-xl border bg-surface-overlay px-3.5 py-3 shadow-panel',
              toneClass[item.tone]
            )}
          >
            <div className="flex items-start gap-2.5">
              <Icon
                size={16}
                className={cn(
                  'mt-0.5 shrink-0',
                  item.tone === 'success' && 'text-success',
                  item.tone === 'error' && 'text-danger',
                  item.tone === 'warning' && 'text-warning',
                  item.tone === 'info' && 'text-accent'
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">{item.title}</div>
                {item.description ? (
                  <p className="mt-0.5 text-xs text-ink-muted">{item.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                className="btn-ghost btn-icon"
                aria-label="Đóng thông báo"
                onClick={() => dismissToast(item.id)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
