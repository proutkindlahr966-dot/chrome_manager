import type { ChromeProfile, ProfileGroup } from './types'

export type DataImportMode = 'groups' | 'profiles' | 'folders'

export interface DataImportLayout {
  root: string
  profilesDir: string
  dbPath: string | null
  /** Chọn 1 thư mục UUID (vd. E:\0dde16d0-…) — không quét cả ổ đĩa. */
  onlyFolderNames?: string[]
}

export interface DataImportPreview {
  layout: DataImportLayout
  mode: DataImportMode
  groupCount: number
  profileCount: number
  folderCount: number
  orphanFolderCount: number
  healCount: number
  alreadyPresentCount: number
  alreadyPresentNames: string[]
  dbFound: boolean
  groupNames: string[]
}

export interface DataImportOptions {
  /** Gán hồ sơ mới / chưa nhóm vào nhóm đang chọn trên UI. */
  groupId?: string | null
}

export interface DataImportResult {
  mode: DataImportMode
  groupsCreated: number
  profilesCreated: number
  profilesHealed: number
  dirsCopied: number
  dirsLinked: number
  alreadyPresent: number
  readyNames: string[]
  skipped: Array<{ name: string; reason: string }>
}

export interface StoreSnapshot {
  profiles: ChromeProfile[]
  groups: ProfileGroup[]
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function looksLikeUuid(name: string): boolean {
  return UUID_RE.test(name.trim())
}

export function summarizeDataImport(result: DataImportResult): {
  tone: 'success' | 'warning'
  title: string
  description: string
} {
  const names = result.readyNames.slice(0, 4).join(', ')
  const changed =
    result.groupsCreated +
    result.profilesCreated +
    result.profilesHealed +
    result.dirsCopied +
    result.dirsLinked +
    result.alreadyPresent
  if (result.dirsLinked > 0 && result.dirsCopied === 0 && result.alreadyPresent === 0) {
    return {
      tone: 'success',
      title: 'Đã gắn hồ sơ',
      description: `${names || 'Hồ sơ'} dùng đúng thư mục Chrome gốc — Gmail và tab được giữ nguyên. Đóng Chrome đang mở thư mục đó trước khi mở từ app.`
    }
  }
  if (
    result.alreadyPresent > 0 &&
    result.profilesCreated === 0 &&
    result.dirsCopied === 0 &&
    result.profilesHealed === 0
  ) {
    return {
      tone: 'success',
      title: 'Hồ sơ đã có sẵn',
      description: `${names || 'Hồ sơ này'} đã nằm trong danh sách (thường ở bộ lọc Chưa nhóm). Session Chrome được giữ nguyên — không tạo bản mới.`
    }
  }
  const skip =
    result.skipped.length > 0 ? ` ${result.skipped[0].name}: ${result.skipped[0].reason}` : ''
  return {
    tone: changed > 0 ? 'success' : 'warning',
    title: 'Đã nhập dữ liệu',
    description: `Nhóm ${result.groupsCreated}, hồ sơ ${result.profilesCreated}, chữa ${result.profilesHealed}, gắn ${result.dirsLinked}, copy ${result.dirsCopied}, có sẵn ${result.alreadyPresent}.${skip}`
  }
}

export function parseStoreSnapshot(raw: string): StoreSnapshot | null {
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const obj = data as Record<string, unknown>
    const profiles = Array.isArray(obj.profiles) ? (obj.profiles as ChromeProfile[]) : []
    const groups = Array.isArray(obj.groups) ? (obj.groups as ProfileGroup[]) : []

    // Export nhóm `{ version, groups:[{ profiles }] }` — không phải chrome-manager-db
    if (typeof obj.version === 'number' && profiles.length === 0) {
      const hasNested = groups.some(
        (g) =>
          g &&
          typeof g === 'object' &&
          Array.isArray((g as ProfileGroup & { profiles?: unknown }).profiles)
      )
      if (hasNested) return null
    }

    if (profiles.length === 0 && groups.length === 0) return null
    return { profiles, groups }
  } catch {
    return null
  }
}

export function decideImportMode(
  snapshot: StoreSnapshot | null,
  folderCount: number
): DataImportMode {
  if (snapshot && snapshot.groups.length > 0 && snapshot.profiles.length > 0) return 'groups'
  if (snapshot && snapshot.groups.length > 0) return 'groups'
  if (snapshot && snapshot.profiles.length > 0) return 'profiles'
  if (folderCount > 0) return 'folders'
  throw new Error('Không có nhóm, hồ sơ hoặc thư mục Chrome để nhập')
}
