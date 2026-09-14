export const PROFILE_PAGE_SIZE_OPTIONS = [25, 50, 100, 500] as const

export type ProfilePageSize = (typeof PROFILE_PAGE_SIZE_OPTIONS)[number]

export const DEFAULT_PROFILE_PAGE_SIZE: ProfilePageSize = 25

const STORAGE_KEY = 'chrome-manager.profile-page-size'

export function loadProfilePageSize(): ProfilePageSize {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const n = Number(raw)
    if (PROFILE_PAGE_SIZE_OPTIONS.includes(n as ProfilePageSize)) {
      return n as ProfilePageSize
    }
  } catch {
    // ignore
  }
  return DEFAULT_PROFILE_PAGE_SIZE
}

export function persistProfilePageSize(value: ProfilePageSize): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // ignore
  }
}
