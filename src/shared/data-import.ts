import { basename, dirname, join, resolve } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import type { ChromeProfile, ProfileGroup } from './types'

export type DataImportMode = 'groups' | 'profiles' | 'folders'

export interface DataImportLayout {
  root: string
  profilesDir: string
  dbPath: string | null
}

export interface DataImportPreview {
  layout: DataImportLayout
  mode: DataImportMode
  groupCount: number
  profileCount: number
  folderCount: number
  orphanFolderCount: number
  dbFound: boolean
  groupNames: string[]
}

export interface DataImportResult {
  mode: DataImportMode
  groupsCreated: number
  profilesCreated: number
  dirsCopied: number
  dirsLinked: number
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

/** Thư mục Chrome user-data (có Default / Local State / Preferences). */
export function looksLikeChromeUserDataDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  return (
    existsSync(join(dir, 'Default')) ||
    existsSync(join(dir, 'Local State')) ||
    existsSync(join(dir, 'Preferences'))
  )
}

function findDbBeside(profilesDir: string): string | null {
  const candidates = [
    join(profilesDir, 'chrome-manager-db.json'),
    join(dirname(profilesDir), 'chrome-manager-db.json'),
    join(dirname(profilesDir), 'data', 'chrome-manager-db.json'),
    join(profilesDir, '..', 'chrome-manager-db.json')
  ]
  for (const p of candidates) {
    const abs = resolve(p)
    if (existsSync(abs)) return abs
  }
  return null
}

/**
 * Nhận diện layout từ đường dẫn người dùng chọn:
 * - thư mục `chrome-profiles` (UUID con)
 * - thư mục `data` (có chrome-profiles)
 * - thư mục gốc chứa cả db + chrome-profiles
 * - file `chrome-manager-db.json`
 */
export function resolveDataImportLayout(selectedPath: string): DataImportLayout {
  const root = resolve(selectedPath.trim())
  if (!existsSync(root)) throw new Error('Đường dẫn không tồn tại')

  let isFile = false
  try {
    isFile = statSync(root).isFile()
  } catch {
    throw new Error('Không đọc được đường dẫn')
  }

  if (isFile) {
    if (!root.toLowerCase().endsWith('.json')) {
      throw new Error('Chỉ hỗ trợ file JSON hoặc thư mục chrome-profiles')
    }
    const dir = dirname(root)
    const siblingProfiles = join(dir, 'chrome-profiles')
    const nestedProfiles = join(dir, 'data', 'chrome-profiles')
    const profilesDir = existsSync(siblingProfiles)
      ? siblingProfiles
      : existsSync(nestedProfiles)
        ? nestedProfiles
        : dir
    return { root: dir, profilesDir, dbPath: root }
  }

  const name = basename(root).toLowerCase()

  // Chọn đúng chrome-profiles
  if (name === 'chrome-profiles') {
    return {
      root: dirname(root),
      profilesDir: root,
      dbPath: findDbBeside(root)
    }
  }

  // Chọn data/ hoặc thư mục có chrome-profiles/
  const nested = join(root, 'chrome-profiles')
  if (existsSync(nested) && statSync(nested).isDirectory()) {
    const dbInRoot = join(root, 'chrome-manager-db.json')
    return {
      root,
      profilesDir: nested,
      dbPath: existsSync(dbInRoot) ? dbInRoot : findDbBeside(nested)
    }
  }

  // Thư mục chứa các UUID trực tiếp
  const kids = readdirSync(root, { withFileTypes: true })
  const uuidDirs = kids.filter((d) => d.isDirectory() && looksLikeUuid(d.name))
  if (uuidDirs.length > 0) {
    return {
      root,
      profilesDir: root,
      dbPath: findDbBeside(root)
    }
  }

  throw new Error(
    'Không tìm thấy thư mục hồ sơ Chrome (chrome-profiles hoặc các thư mục UUID)'
  )
}

export function listProfileFolders(profilesDir: string): string[] {
  if (!existsSync(profilesDir)) return []
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '.git')
    .map((d) => d.name)
    .filter((name) => {
      const full = join(profilesDir, name)
      return looksLikeUuid(name) || looksLikeChromeUserDataDir(full)
    })
    .sort((a, b) => a.localeCompare(b))
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
