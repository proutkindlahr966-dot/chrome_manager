import { existsSync, statSync } from 'fs'
import { basename, extname, resolve } from 'path'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.ico'])

/** Kiểm tra path tuyệt đối nằm trong một thư mục gốc (chống path traversal). */
export function isPathInside(targetPath: string, rootDir: string): boolean {
  const resolvedTarget = resolve(targetPath)
  const resolvedRoot = resolve(rootDir)
  const prefix = resolvedRoot.endsWith('\\') || resolvedRoot.endsWith('/')
    ? resolvedRoot
    : resolvedRoot + (process.platform === 'win32' ? '\\' : '/')
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(prefix)
}

export function isAllowedImagePath(filePath: string): boolean {
  const target = resolve((filePath ?? '').trim())
  if (!target) return false
  const ext = extname(target).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) return false
  if (!existsSync(target)) return false
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

export function safeBasename(filePath: string): string {
  return basename(resolve(filePath))
}
