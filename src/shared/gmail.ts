import type { GmailCredentials } from './types'

export const EMPTY_GMAIL: GmailCredentials = {
  email: '',
  password: '',
  recoveryEmail: '',
  totpSecret: '',
  raw: ''
}

/** Parse nhiều dòng mail|pass|2fa hoặc mail|pass|recovery|2fa (bỏ dòng trống) */
export function parseGmailList(raw: string): GmailCredentials[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseGmailLine)
    .filter((item) => Boolean(item.email && item.password))
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

export function isSixDigitCode(value: string): boolean {
  return /^\d{6}$/.test(value.replace(/\s+/g, ''))
}

/** Secret Base32 (không phải email) */
function looksLikeTotpSecret(value: string): boolean {
  let s = value.trim()
  if (!s) return false
  if (/otpauth:\/\//i.test(s) && /[?&]secret=/i.test(s)) return true
  s = s.replace(/[\s\-]+/g, '')
  if (isSixDigitCode(s)) return false
  if (s.length < 16) return false
  return /^[A-Z2-7]+=*$/i.test(s)
}

function normalizeTotpField(value: string): string {
  let s = value.trim()
  if (!s) return ''
  const compact = s.replace(/[\s\-]+/g, '')
  if (isSixDigitCode(compact)) return compact
  const m = s.match(/[?&]secret=([^&]+)/i)
  if (m?.[1]) s = decodeURIComponent(m[1])
  return s.replace(/[\s\-]+/g, '').toUpperCase()
}

/**
 * Cột 3 (sau mail|pass|) = mã 2FA 6 số.
 * Hỗ trợ thêm: mail|pass|recovery|2fa và mail|pass|2fa|recovery
 */
function take2faAndRecovery(parts: string[]): { recoveryEmail: string; totp: string } {
  const p2 = (parts[2] ?? '').trim()
  const p3 = (parts[3] ?? '').trim()

  if (parts.length <= 2) return { recoveryEmail: '', totp: '' }

  if (parts.length === 3) {
    if (looksLikeEmail(p2)) return { recoveryEmail: p2, totp: '' }
    return { recoveryEmail: '', totp: p2 }
  }

  if (isSixDigitCode(p2) || (looksLikeTotpSecret(p2) && !looksLikeEmail(p2) && !isSixDigitCode(p3))) {
    return { recoveryEmail: looksLikeEmail(p3) ? p3 : '', totp: p2 }
  }

  return { recoveryEmail: p2, totp: p3 }
}

/** Parse chuỗi mail|pass|2fa (cột 3 = mã 6 số) */
export function parseGmailLine(raw: string): GmailCredentials {
  const trimmed = raw.trim()
  if (!trimmed) return { ...EMPTY_GMAIL }

  const parts = trimmed.split('|').map((p) => p.trim())
  const { recoveryEmail, totp } = take2faAndRecovery(parts)

  return {
    email: parts[0] ?? '',
    password: parts[1] ?? '',
    recoveryEmail,
    totpSecret: normalizeTotpField(totp),
    raw: trimmed
  }
}

/** Dữ liệu cột 2FA gốc (cột 3: mail|pass|2fa) — dùng dán 2fa.live */
export function getGmailColumn3(creds: GmailCredentials | null | undefined): string {
  if (!creds) return ''
  if (creds.raw?.trim()) {
    const parts = creds.raw.trim().split('|').map((p) => p.trim())
    const { totp } = take2faAndRecovery(parts)
    if (totp) return totp
  }
  return (creds.totpSecret || '').trim()
}

/** Mã 2FA: 6 số (cột 3) hoặc secret Base32 */
export function resolveTotpSecret(creds: GmailCredentials | null | undefined): string {
  if (!creds) return ''
  const direct = normalizeTotpField(creds.totpSecret || '')
  if (direct) return direct
  const rec = (creds.recoveryEmail || '').trim()
  if (rec && !looksLikeEmail(rec) && (isSixDigitCode(rec) || looksLikeTotpSecret(rec))) {
    return normalizeTotpField(rec)
  }
  if (creds.raw?.trim()) {
    const parsed = parseGmailLine(creds.raw)
    if (parsed.totpSecret) return parsed.totpSecret
  }
  return ''
}

export function serializeGmail(creds: GmailCredentials | null | undefined): string {
  if (!creds) return ''
  if (creds.raw?.trim()) return creds.raw.trim()
  const parts = [creds.email, creds.password, creds.recoveryEmail, creds.totpSecret]
  if (parts.every((p) => !p)) return ''
  return parts.join('|')
}

export function normalizeGmail(
  input: Partial<GmailCredentials> | null | undefined
): GmailCredentials | null {
  if (!input) return null
  const fromRaw = input.raw?.trim() ? parseGmailLine(input.raw) : null
  const email = (input.email ?? fromRaw?.email ?? '').trim()
  const password = input.password ?? fromRaw?.password ?? ''
  let recoveryEmail = (input.recoveryEmail?.trim() || fromRaw?.recoveryEmail || '').trim()
  const totpSecret = resolveTotpSecret({
    email,
    password,
    recoveryEmail,
    totpSecret: input.totpSecret?.trim() || fromRaw?.totpSecret || '',
    raw: input.raw?.trim() || fromRaw?.raw || ''
  })
  if (
    totpSecret &&
    recoveryEmail &&
    !looksLikeEmail(recoveryEmail) &&
    (isSixDigitCode(recoveryEmail) || looksLikeTotpSecret(recoveryEmail))
  ) {
    recoveryEmail = ''
  }

  if (!email && !password && !recoveryEmail && !totpSecret) return null

  const creds: GmailCredentials = {
    email,
    password,
    recoveryEmail,
    totpSecret,
    raw: input.raw?.trim() || serializeGmail({ email, password, recoveryEmail, totpSecret })
  }
  return creds
}

export function hasGmailCredentials(creds: GmailCredentials | null | undefined): boolean {
  return Boolean(creds?.email?.trim() && creds?.password)
}

/** Chuẩn hoá email để so trùng (1 mail = 1 profile) */
export function normalizeEmailKey(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}
