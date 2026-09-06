import { cn } from '@/lib/utils'

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

interface BadgeProps {
  children: React.ReactNode
  tone?: BadgeTone
  className?: string
  dot?: boolean
}

const toneClass: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-ink-soft',
  accent: 'bg-accent-soft text-accent-strong',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger'
}

export function Badge({
  children,
  tone = 'neutral',
  className,
  dot
}: BadgeProps): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-2xs font-medium',
        toneClass[tone],
        className
      )}
    >
      {dot ? (
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            tone === 'success' && 'animate-pulse-dot bg-success',
            tone === 'danger' && 'bg-danger',
            tone === 'warning' && 'bg-warning',
            tone === 'accent' && 'bg-accent',
            tone === 'neutral' && 'bg-ink-muted'
          )}
        />
      ) : null}
      {children}
    </span>
  )
}
