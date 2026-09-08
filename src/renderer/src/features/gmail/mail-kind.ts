export type GmailMailKind = 'old' | 'new'

const MAIL_KIND_STORAGE_KEY = 'gmail-mail-kind'

export function loadSavedMailKind(): GmailMailKind {
  try {
    const raw = localStorage.getItem(MAIL_KIND_STORAGE_KEY)
    if (raw === 'new' || raw === 'old') return raw
  } catch {
    // ignore
  }
  return 'old'
}

export function persistMailKind(value: GmailMailKind): void {
  try {
    localStorage.setItem(MAIL_KIND_STORAGE_KEY, value)
  } catch {
    // ignore
  }
}
