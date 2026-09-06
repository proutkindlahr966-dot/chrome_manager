import { app } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'

/**
 * Thư mục gốc dự án.
 * - Dev: tìm `package.json` đi lên từ `__dirname`
 * - Packaged: cạnh file .exe
 */
export function getProjectRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, '..')
  }
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return join(__dirname, '../..')
}

/** Thư mục dữ liệu runtime: profiles, gmail list, screenshots… */
export function getDataRoot(): string {
  // Packaged: ghi vào userData (tránh Program Files không có quyền ghi)
  const root = app.isPackaged
    ? join(app.getPath('userData'), 'data')
    : join(getProjectRoot(), 'data')
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

export function getDefaultProfilesRoot(): string {
  return join(getDataRoot(), 'chrome-profiles')
}

export function getDebugScreenshotsDir(): string {
  return join(getDataRoot(), 'debug-screenshots')
}

export function getGmailListPath(): string {
  return join(getDataRoot(), 'gmail-list.txt')
}

export function getGmailFailedPath(): string {
  return join(getDataRoot(), 'gmail-failed.txt')
}

export function getGmailSetupPath(): string {
  return join(getDataRoot(), 'gmail-setup.json')
}

/** Di chuyển file/folder legacy từ project root → data/ (một lần). */
export function migrateLegacyDataFile(fileName: string): void {
  const legacy = join(getProjectRoot(), fileName)
  const next = join(getDataRoot(), fileName)
  if (!existsSync(legacy) || existsSync(next)) return
  try {
    renameSync(legacy, next)
  } catch (error) {
    console.error(`[paths] Không migrate được ${fileName}`, error)
  }
}

/** Di chuyển thư mục legacy chrome-profiles / debug-screenshots. */
export function migrateLegacyDataDir(dirName: string): void {
  const legacy = join(getProjectRoot(), dirName)
  const next = join(getDataRoot(), dirName)
  if (!existsSync(legacy) || existsSync(next)) return
  try {
    mkdirSync(getDataRoot(), { recursive: true })
    renameSync(legacy, next)
  } catch (error) {
    console.error(`[paths] Không migrate được thư mục ${dirName}`, error)
  }
}
