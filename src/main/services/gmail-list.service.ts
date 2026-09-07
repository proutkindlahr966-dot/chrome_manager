import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import {
  DEFAULT_GMAIL_POST_SETUP,
  type GmailPostSetupConfig
} from '../../shared/types'
import {
  getGmailFailedPath,
  getGmailListPath,
  getGmailSetupPath,
  migrateLegacyDataFile
} from '../utils/paths'

function ensureGmailFilesMigrated(): void {
  migrateLegacyDataFile('gmail-list.txt')
  migrateLegacyDataFile('gmail-failed.txt')
  migrateLegacyDataFile('gmail-setup.json')
}

export { getGmailListPath, getGmailFailedPath, getGmailSetupPath }

export function loadGmailList(): string {
  ensureGmailFilesMigrated()
  const filePath = getGmailListPath()
  if (!existsSync(filePath)) return ''
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

export function saveGmailList(content: string): { path: string; count: number } {
  ensureGmailFilesMigrated()
  const filePath = getGmailListPath()
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, content ?? '', 'utf-8')
  const count = (content ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length
  return { path: filePath, count }
}

function normalizeFailedEmails(emails: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of emails) {
    const email = raw.trim()
    if (!email) continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(email)
  }
  return result
}

/** Danh sách email đã chạy lỗi / bỏ qua (mỗi dòng 1 email) */
export function loadFailedGmailEmails(): string[] {
  ensureGmailFilesMigrated()
  const filePath = getGmailFailedPath()
  if (!existsSync(filePath)) return []
  try {
    return normalizeFailedEmails(readFileSync(filePath, 'utf-8').split(/\r?\n/))
  } catch {
    return []
  }
}

export function saveFailedGmailEmails(emails: string[]): { path: string; count: number } {
  ensureGmailFilesMigrated()
  const filePath = getGmailFailedPath()
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const normalized = normalizeFailedEmails(emails)
  writeFileSync(filePath, normalized.join('\n') + (normalized.length ? '\n' : ''), 'utf-8')
  return { path: filePath, count: normalized.length }
}

export function loadGmailSetup(): GmailPostSetupConfig {
  ensureGmailFilesMigrated()
  const filePath = getGmailSetupPath()
  if (!existsSync(filePath)) return { ...DEFAULT_GMAIL_POST_SETUP }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<GmailPostSetupConfig>
    return {
      enabled: raw.enabled !== false,
      avatarPath: typeof raw.avatarPath === 'string' ? raw.avatarPath : '',
      appsScriptPath: typeof raw.appsScriptPath === 'string' ? raw.appsScriptPath : '',
      appsScriptCode: typeof raw.appsScriptCode === 'string' ? raw.appsScriptCode : '',
      formFillEnabled: Boolean(raw.formFillEnabled),
      formTitle: typeof raw.formTitle === 'string' ? raw.formTitle : '',
      formDescription: typeof raw.formDescription === 'string' ? raw.formDescription : '',
      formHeaderPath: typeof raw.formHeaderPath === 'string' ? raw.formHeaderPath : ''
    }
  } catch {
    return { ...DEFAULT_GMAIL_POST_SETUP }
  }
}

export function saveGmailSetup(config: GmailPostSetupConfig): {
  path: string
  config: GmailPostSetupConfig
} {
  ensureGmailFilesMigrated()
  const filePath = getGmailSetupPath()
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const normalized: GmailPostSetupConfig = {
    enabled: Boolean(config.enabled),
    avatarPath: (config.avatarPath ?? '').trim(),
    appsScriptPath: (config.appsScriptPath ?? '').trim(),
    appsScriptCode: config.appsScriptCode ?? '',
    formFillEnabled: Boolean(config.formFillEnabled),
    formTitle: config.formTitle ?? '',
    formDescription: config.formDescription ?? '',
    formHeaderPath: (config.formHeaderPath ?? '').trim()
  }
  writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8')
  return { path: filePath, config: normalized }
}

/** Đọc code Apps Script: ưu tiên file .txt, fallback nội dung inline */
export function resolveAppsScriptCode(options?: {
  appsScriptPath?: string
  appsScriptCode?: string
}): { code: string; source: string } {
  const path = (options?.appsScriptPath ?? '').trim()
  if (path) {
    if (!existsSync(path)) {
      throw new Error(`Không tìm thấy file Apps Script: ${path}`)
    }
    const code = readFileSync(path, 'utf-8')
    if (!code.trim()) {
      throw new Error(`File Apps Script trống: ${path}`)
    }
    return { code, source: path }
  }
  const inline = options?.appsScriptCode ?? ''
  return { code: inline, source: inline.trim() ? 'inline' : '' }
}
