import { basename, dirname, join, resolve } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import {
  looksLikeUuid,
  type DataImportLayout
} from '../../shared/data-import'

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

function isSubstantialFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 32
  } catch {
    return false
  }
}

/** Đã có session thật (cookie / history) — khác thư mục trống hoặc chỉ mới có Preferences. */
export function chromeUserDataLooksPopulated(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false
  return [
    join(dir, 'Default', 'Network', 'Cookies'),
    join(dir, 'Default', 'Cookies'),
    join(dir, 'Default', 'History'),
    join(dir, 'Default', 'Login Data')
  ].some(isSubstantialFile)
}

/** So sánh session nguồn/đích để quyết định copy đè. */
export function chromeSessionFingerprint(dir: string): string {
  if (!dir || !existsSync(dir)) return ''
  return [
    join(dir, 'Default', 'Network', 'Cookies'),
    join(dir, 'Default', 'Cookies'),
    join(dir, 'Default', 'History'),
    join(dir, 'Default', 'Login Data'),
    join(dir, 'Default', 'Preferences')
  ]
    .map((p) => {
      try {
        const s = statSync(p)
        return `${s.size}:${Math.floor(s.mtimeMs)}`
      } catch {
        return '0'
      }
    })
    .join('|')
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
 * - 1 thư mục UUID (user-data Chrome) — vd. E:\0dde16d0-3495-…
 * - thư mục `chrome-profiles` (nhiều UUID con)
 * - thư mục `data` (có chrome-profiles)
 * - thư mục chứa các UUID
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
      throw new Error('Chỉ hỗ trợ file JSON hoặc thư mục hồ sơ Chrome')
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

  const folderName = basename(root)
  const name = folderName.toLowerCase()

  // Một thư mục hồ sơ Chrome (UUID hoặc có Default / Local State)
  if (looksLikeChromeUserDataDir(root) || looksLikeUuid(folderName)) {
    return {
      root: dirname(root),
      profilesDir: dirname(root),
      dbPath: findDbBeside(dirname(root)),
      onlyFolderNames: [folderName]
    }
  }

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

  // Thư mục chứa các UUID trực tiếp (không quét cả ổ đĩa nếu quá nhiều mục)
  let kids
  try {
    kids = readdirSync(root, { withFileTypes: true })
  } catch {
    throw new Error('Không đọc được thư mục đã chọn')
  }
  const uuidDirs = kids.filter((d) => d.isDirectory() && looksLikeUuid(d.name))
  if (uuidDirs.length > 0) {
    return {
      root,
      profilesDir: root,
      dbPath: findDbBeside(root)
    }
  }

  throw new Error(
    'Không tìm thấy hồ sơ Chrome. Hãy chọn thư mục UUID (có Default/Local State), chrome-profiles, hoặc data.'
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

export function listFoldersForLayout(layout: DataImportLayout): string[] {
  if (layout.onlyFolderNames?.length) {
    return layout.onlyFolderNames.filter((name) => {
      const full = join(layout.profilesDir, name)
      try {
        return existsSync(full) && statSync(full).isDirectory()
      } catch {
        return false
      }
    })
  }
  return listProfileFolders(layout.profilesDir)
}
