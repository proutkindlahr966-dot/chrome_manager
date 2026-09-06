import { safeStorage } from 'electron'
import type { ChromeProfile, GmailCredentials, ProxyConfig } from '../../shared/types'

const PREFIX = 'enc:v1:'

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (plain.startsWith(PREFIX)) return plain
  if (!safeStorage.isEncryptionAvailable()) return plain
  try {
    return PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    return plain
  }
}

export function decryptSecret(value: string): string {
  if (!value) return ''
  if (!value.startsWith(PREFIX)) return value
  if (!safeStorage.isEncryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

function encryptGmail(gmail: GmailCredentials | null | undefined): GmailCredentials | null {
  if (!gmail) return null
  return {
    ...gmail,
    password: encryptSecret(gmail.password ?? ''),
    totpSecret: encryptSecret(gmail.totpSecret ?? ''),
    recoveryEmail: gmail.recoveryEmail ?? '',
    email: gmail.email ?? '',
    raw: gmail.raw ? encryptSecret(gmail.raw) : gmail.raw
  }
}

function decryptGmail(gmail: GmailCredentials | null | undefined): GmailCredentials | null {
  if (!gmail) return null
  return {
    ...gmail,
    password: decryptSecret(gmail.password ?? ''),
    totpSecret: decryptSecret(gmail.totpSecret ?? ''),
    recoveryEmail: gmail.recoveryEmail ?? '',
    email: gmail.email ?? '',
    raw: gmail.raw ? decryptSecret(gmail.raw) : gmail.raw
  }
}

function encryptProxy(proxy: ProxyConfig): ProxyConfig {
  return {
    ...proxy,
    password: encryptSecret(proxy.password ?? '')
  }
}

function decryptProxy(proxy: ProxyConfig): ProxyConfig {
  return {
    ...proxy,
    password: decryptSecret(proxy.password ?? '')
  }
}

/** Mã hóa secrets trước khi ghi đĩa — không mutate object gốc. */
export function encryptProfileForDisk(profile: ChromeProfile): ChromeProfile {
  return {
    ...profile,
    gmail: encryptGmail(profile.gmail),
    proxy: encryptProxy(profile.proxy)
  }
}

/** Giải mã secrets sau khi đọc đĩa. */
export function decryptProfileFromDisk(profile: ChromeProfile): ChromeProfile {
  return {
    ...profile,
    gmail: decryptGmail(profile.gmail),
    proxy: decryptProxy(profile.proxy)
  }
}
