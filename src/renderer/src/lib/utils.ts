import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, formatDistanceToNow } from 'date-fns'
import { vi } from 'date-fns/locale'
import type { ProfileStatus } from '@shared/types'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  try {
    return format(new Date(value), 'dd/MM/yyyy HH:mm')
  } catch {
    return '—'
  }
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'Chưa chạy'
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true, locale: vi })
  } catch {
    return '—'
  }
}

export function statusLabel(status: ProfileStatus): string {
  switch (status) {
    case 'running':
      return 'Đang chạy'
    case 'starting':
      return 'Đang mở'
    case 'stopping':
      return 'Đang đóng'
    case 'error':
      return 'Lỗi'
    default:
      return 'Sẵn sàng'
  }
}

export function statusBadgeTone(
  status: ProfileStatus
): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'running') return 'success'
  if (status === 'starting' || status === 'stopping') return 'warning'
  if (status === 'error') return 'danger'
  return 'neutral'
}

/** Tiền tố mặc định khi tạo hồ sơ mới */
export const DEFAULT_PROFILE_PREFIX = 'Profile'

/** Lấy số tiếp theo từ các tên dạng "Prefix 01", "Prefix 2"... */
export function suggestNextIndex(names: string[], prefix: string): number {
  const base = prefix.trim() || DEFAULT_PROFILE_PREFIX
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped}\\s*(\\d+)$`, 'i')
  let max = 0
  for (const name of names) {
    const match = name.trim().match(re)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

export function formatProfileName(prefix: string, index: number, pad = 2): string {
  const base = prefix.trim() || DEFAULT_PROFILE_PREFIX
  const width = Math.max(pad, String(index).length)
  return `${base} ${String(index).padStart(width, '0')}`
}

