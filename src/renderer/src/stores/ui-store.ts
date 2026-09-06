import { create } from 'zustand'

export type ToastTone = 'info' | 'success' | 'error' | 'warning'

export interface ToastItem {
  id: string
  tone: ToastTone
  title: string
  description?: string
  duration?: number
}

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void
}

interface UiState {
  toasts: ToastItem[]
  confirm: PendingConfirm | null
  toast: (input: Omit<ToastItem, 'id'> | string) => void
  dismissToast: (id: string) => void
  askConfirm: (options: ConfirmOptions) => Promise<boolean>
  resolveConfirm: (value: boolean) => void
}

let toastSeq = 0

export const useUiStore = create<UiState>((set, get) => ({
  toasts: [],
  confirm: null,

  toast: (input) => {
    const item: ToastItem =
      typeof input === 'string'
        ? { id: `t-${++toastSeq}`, tone: 'info', title: input, duration: 3200 }
        : {
            id: `t-${++toastSeq}`,
            duration: 3200,
            ...input
          }
    set((s) => ({ toasts: [...s.toasts.slice(-4), item] }))
    const duration = item.duration ?? 3200
    if (duration > 0) {
      window.setTimeout(() => get().dismissToast(item.id), duration)
    }
  },

  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  askConfirm: (options) =>
    new Promise<boolean>((resolve) => {
      set({ confirm: { ...options, resolve } })
    }),

  resolveConfirm: (value) => {
    const pending = get().confirm
    if (!pending) return
    pending.resolve(value)
    set({ confirm: null })
  }
}))

export function toast(input: Omit<ToastItem, 'id'> | string): void {
  useUiStore.getState().toast(input)
}

export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return useUiStore.getState().askConfirm(options)
}
