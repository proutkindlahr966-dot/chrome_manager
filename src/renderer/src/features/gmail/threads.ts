const THREADS_STORAGE_KEY = 'gmail-chrome-threads'
export const THREADS_MIN = 1
export const THREADS_MAX = 20

export function loadSavedThreads(): number {
  try {
    const raw = localStorage.getItem(THREADS_STORAGE_KEY)
    if (raw == null) return 3
    const n = Number(raw)
    if (!Number.isFinite(n)) return 3
    return Math.min(THREADS_MAX, Math.max(THREADS_MIN, Math.floor(n)))
  } catch {
    return 3
  }
}

export function persistThreads(value: number): void {
  try {
    localStorage.setItem(THREADS_STORAGE_KEY, String(value))
  } catch {
    // ignore
  }
}

export function clampThreads(value: number): number {
  return Math.min(THREADS_MAX, Math.max(THREADS_MIN, Math.floor(value) || THREADS_MIN))
}
