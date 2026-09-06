import { cn } from '@/lib/utils'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  title?: string
  className?: string
  size?: 'sm' | 'md'
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  title,
  className,
  size = 'md'
}: SwitchProps): JSX.Element {
  const track =
    size === 'sm' ? 'h-5 w-9' : 'h-6 w-11'
  const thumb =
    size === 'sm'
      ? cn('h-3.5 w-3.5', checked ? 'translate-x-[18px]' : 'translate-x-0.5')
      : cn('h-4 w-4', checked ? 'translate-x-6' : 'translate-x-1')

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition',
        track,
        checked ? 'bg-accent' : 'bg-surface-muted',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
      onClick={() => onChange(!checked)}
    >
      <span
        className={cn(
          'inline-block transform rounded-full bg-white shadow transition',
          thumb
        )}
      />
    </button>
  )
}
