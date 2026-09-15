import { normalizeGmail, parseGmailLine } from './gmail'
import { parseProxyString } from './proxy'
import {
  DEFAULT_PROXY,
  GROUP_COLORS,
  type ChromeProfile,
  type CreateProfileInput,
  type GmailCredentials,
  type ProfileGroup,
  type ProxyConfig
} from './types'

export const GROUP_IMPORT_VERSION = 1

/** Hồ sơ trong payload nhập (không gồm id / dataDir) */
export interface ImportProfileItem {
  name: string
  notes?: string
  userAgent?: string
  homepage?: string
  tags?: string[]
  /** Object proxy hoặc chuỗi host:port:user:pass */
  proxy?: Partial<ProxyConfig> | string
  /** Object gmail hoặc chuỗi mail|pass|2fa */
  gmail?: Partial<GmailCredentials> | string | null
  autoLoginGmail?: boolean
}

export interface ImportGroupItem {
  name: string
  color?: string
  description?: string
  restoreLastSession?: boolean
  profiles?: ImportProfileItem[]
}

export interface ImportGroupsPayload {
  version?: number
  groups: ImportGroupItem[]
}

export interface ImportGroupsResult {
  groupsCreated: number
  profilesCreated: number
  skipped: Array<{ groupName: string; profileName: string; reason: string }>
  groupIds: string[]
}

export interface ExportGroupsPayload {
  version: number
  exportedAt: string
  groups: Array<{
    name: string
    color: string
    description: string
    restoreLastSession: boolean
    profiles: Array<{
      name: string
      notes: string
      userAgent: string
      homepage: string
      tags: string[]
      proxy: ProxyConfig
      gmail: GmailCredentials | null
      autoLoginGmail: boolean
    }>
  }>
}

const MAX_GROUPS = 100
const MAX_PROFILES_TOTAL = 2000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function parseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
}

function parseProxyField(value: unknown): Partial<ProxyConfig> | undefined {
  if (value == null || value === '') return undefined
  if (typeof value === 'string') {
    const parsed = parseProxyString(value)
    return parsed.type === 'none' && !parsed.host ? undefined : parsed
  }
  if (!isPlainObject(value)) return undefined
  const type = asString(value.type, 'none') as ProxyConfig['type']
  return {
    type: ['none', 'http', 'https', 'socks5'].includes(type) ? type : 'http',
    host: asString(value.host),
    port:
      typeof value.port === 'number' && Number.isFinite(value.port)
        ? value.port
        : value.port == null
          ? null
          : Number(value.port) || null,
    username: asString(value.username),
    password: asString(value.password)
  }
}

function parseGmailField(value: unknown): Partial<GmailCredentials> | null | undefined {
  if (value === null) return null
  if (value === undefined || value === '') return undefined
  if (typeof value === 'string') {
    const parsed = parseGmailLine(value)
    return parsed.email || parsed.password ? parsed : undefined
  }
  if (!isPlainObject(value)) return undefined
  return {
    email: asString(value.email),
    password: asString(value.password),
    recoveryEmail: asString(value.recoveryEmail),
    totpSecret: asString(value.totpSecret),
    raw: asOptionalString(value.raw)
  }
}

function parseProfileItem(raw: unknown, index: number): ImportProfileItem {
  if (!isPlainObject(raw)) {
    throw new Error(`Hồ sơ #${index + 1} không hợp lệ`)
  }
  const name = asString(raw.name).trim()
  if (!name) throw new Error(`Hồ sơ #${index + 1} thiếu tên`)
  return {
    name,
    notes: asOptionalString(raw.notes),
    userAgent: asOptionalString(raw.userAgent),
    homepage: asOptionalString(raw.homepage),
    tags: parseTags(raw.tags),
    proxy: parseProxyField(raw.proxy),
    gmail: parseGmailField(raw.gmail),
    autoLoginGmail: typeof raw.autoLoginGmail === 'boolean' ? raw.autoLoginGmail : undefined
  }
}

function parseGroupItem(raw: unknown, index: number): ImportGroupItem {
  if (!isPlainObject(raw)) {
    throw new Error(`Nhóm #${index + 1} không hợp lệ`)
  }
  const name = asString(raw.name).trim()
  if (!name) throw new Error(`Nhóm #${index + 1} thiếu tên`)

  const profilesRaw = raw.profiles
  let profiles: ImportProfileItem[] | undefined
  if (profilesRaw !== undefined) {
    if (!Array.isArray(profilesRaw)) {
      throw new Error(`Nhóm "${name}": profiles phải là mảng`)
    }
    profiles = profilesRaw.map((p, i) => parseProfileItem(p, i))
  }

  const color = asOptionalString(raw.color)?.trim()
  return {
    name,
    color: color || undefined,
    description: asOptionalString(raw.description),
    restoreLastSession:
      raw.restoreLastSession === undefined ? undefined : asBoolean(raw.restoreLastSession, true),
    profiles
  }
}

/**
 * Parse JSON nhập nhóm (+ hồ sơ).
 * Chấp nhận: `{ groups: [...] }` hoặc mảng `[...]` trực tiếp.
 */
export function parseImportGroupsJson(raw: string): ImportGroupsPayload {
  const text = raw.trim()
  if (!text) throw new Error('Nội dung trống')

  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch {
    throw new Error('JSON không hợp lệ')
  }

  let groupsRaw: unknown[]
  let version: number | undefined

  if (Array.isArray(data)) {
    groupsRaw = data
  } else if (isPlainObject(data)) {
    if (typeof data.version === 'number') version = data.version
    if (!Array.isArray(data.groups)) {
      throw new Error('Thiếu mảng "groups"')
    }
    groupsRaw = data.groups
  } else {
    throw new Error('Định dạng không được hỗ trợ')
  }

  if (groupsRaw.length === 0) throw new Error('Không có nhóm nào để nhập')
  if (groupsRaw.length > MAX_GROUPS) {
    throw new Error(`Tối đa ${MAX_GROUPS} nhóm mỗi lần nhập`)
  }

  const groups = groupsRaw.map((g, i) => parseGroupItem(g, i))
  const totalProfiles = groups.reduce((sum, g) => sum + (g.profiles?.length ?? 0), 0)
  if (totalProfiles > MAX_PROFILES_TOTAL) {
    throw new Error(`Tối đa ${MAX_PROFILES_TOTAL} hồ sơ mỗi lần nhập`)
  }

  return { version, groups }
}

export function summarizeImportPayload(payload: ImportGroupsPayload): {
  groupCount: number
  profileCount: number
  names: string[]
} {
  return {
    groupCount: payload.groups.length,
    profileCount: payload.groups.reduce((sum, g) => sum + (g.profiles?.length ?? 0), 0),
    names: payload.groups.map((g) => g.name)
  }
}

export function toCreateProfileInput(
  item: ImportProfileItem,
  groupId: string
): CreateProfileInput {
  const gmail =
    item.gmail === undefined
      ? undefined
      : item.gmail === null
        ? null
        : normalizeGmail(
            typeof item.gmail === 'string' ? parseGmailLine(item.gmail) : item.gmail
          )

  const proxy =
    item.proxy === undefined
      ? undefined
      : typeof item.proxy === 'string'
        ? parseProxyString(item.proxy)
        : { ...DEFAULT_PROXY, ...item.proxy }

  return {
    name: item.name,
    notes: item.notes,
    groupId,
    userAgent: item.userAgent,
    homepage: item.homepage,
    tags: item.tags,
    proxy,
    gmail,
    autoLoginGmail: item.autoLoginGmail
  }
}

export function buildExportPayload(
  groups: ProfileGroup[],
  profiles: ChromeProfile[]
): ExportGroupsPayload {
  const byGroup = new Map<string, ChromeProfile[]>()
  for (const p of profiles) {
    if (!p.groupId) continue
    const list = byGroup.get(p.groupId) ?? []
    list.push(p)
    byGroup.set(p.groupId, list)
  }

  return {
    version: GROUP_IMPORT_VERSION,
    exportedAt: new Date().toISOString(),
    groups: groups.map((g) => ({
      name: g.name,
      color: g.color || GROUP_COLORS[0],
      description: g.description ?? '',
      restoreLastSession: g.restoreLastSession !== false,
      profiles: (byGroup.get(g.id) ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
        .map((p) => ({
          name: p.name,
          notes: p.notes ?? '',
          userAgent: p.userAgent ?? '',
          homepage: p.homepage ?? 'chrome://newtab/',
          tags: [...(p.tags ?? [])],
          proxy: { ...DEFAULT_PROXY, ...p.proxy },
          gmail: p.gmail ? normalizeGmail(p.gmail) : null,
          autoLoginGmail: Boolean(p.autoLoginGmail)
        }))
    }))
  }
}

export function formatExportJson(payload: ExportGroupsPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`
}
