import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import {
  CreateGroupInput,
  CreateProfileInput,
  BulkCreateProfileInput,
  ProfileFilters,
  UpdateGroupInput,
  UpdateProfileInput,
  AppSettings,
  DashboardStats,
  ChromeProfile
} from '../../shared/types'
import { getDb } from '../db/database'
import {
  arrangeProfileWindows,
  bulkLaunch,
  bulkStop,
  computeTileLayout,
  detectChromePath,
  launchProfile,
  stopProfile
} from './chrome.service'
import { hasGmailCredentials } from '../../shared/gmail'
import type { GmailLoginOptions, ImagePreview } from '../../shared/types'
import { isAllowedImagePath, safeBasename } from '../utils/path-guard'
import { sanitizeDashboardStats } from '../utils/profile-sanitize'

function applyFilters(profiles: ChromeProfile[], filters?: ProfileFilters): ChromeProfile[] {
  let result = [...profiles]
  const search = filters?.search?.trim().toLowerCase()
  if (search) {
    result = result.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        p.notes.toLowerCase().includes(search) ||
        p.tags.some((t) => t.toLowerCase().includes(search)) ||
        (p.gmail?.email ?? '').toLowerCase().includes(search)
    )
  }

  if (filters?.groupId !== undefined) {
    if (filters.groupId === null || filters.groupId === 'ungrouped') {
      result = result.filter((p) => !p.groupId)
    } else if (filters.groupId !== 'all') {
      result = result.filter((p) => p.groupId === filters.groupId)
    }
  }

  if (filters?.status && filters.status !== 'all') {
    result = result.filter((p) => p.status === filters.status)
  }

  const sortBy = filters?.sortBy ?? 'name'
  const sortDir = filters?.sortDir ?? 'asc'
  result.sort((a, b) => {
    const av = a[sortBy] ?? ''
    const bv = b[sortBy] ?? ''
    const cmp = String(av).localeCompare(String(bv), 'vi', { sensitivity: 'base' })
    return sortDir === 'asc' ? cmp : -cmp
  })

  return result
}

export function registerIpcHandlers(): void {
  const db = getDb()

  ipcMain.handle(IPC.PROFILES_LIST, (_e, filters?: ProfileFilters) => {
    return applyFilters(db.listProfiles(), filters)
  })

  ipcMain.handle(IPC.PROFILES_GET, (_e, id: string) => db.getProfile(id) ?? null)

  ipcMain.handle(IPC.PROFILES_CREATE, (_e, input: CreateProfileInput) => db.createProfile(input))

  ipcMain.handle(IPC.PROFILES_BULK_CREATE, (_e, input: BulkCreateProfileInput) =>
    db.createProfiles(input)
  )

  ipcMain.handle(IPC.PROFILES_UPDATE, (_e, id: string, input: UpdateProfileInput) =>
    db.updateProfile(id, input)
  )

  ipcMain.handle(IPC.PROFILES_DELETE, async (_e, id: string) => {
    await stopProfile(id)
    db.deleteProfile(id)
    return true
  })

  ipcMain.handle(IPC.PROFILES_DUPLICATE, (_e, id: string) => db.duplicateProfile(id))

  ipcMain.handle(IPC.PROFILES_BULK_DELETE, async (_e, ids: string[]) => {
    const successIds: string[] = []
    const failed: Array<{ id: string; error: string }> = []
    for (const id of ids) {
      try {
        await stopProfile(id)
        db.deleteProfile(id)
        successIds.push(id)
      } catch (error) {
        failed.push({
          id,
          error: error instanceof Error ? error.message : 'Không thể xóa'
        })
      }
    }
    return { successIds, failed }
  })

  ipcMain.handle(
    IPC.PROFILES_BULK_UPDATE,
    (_e, ids: string[], input: UpdateProfileInput) => {
      const successIds: string[] = []
      const failed: Array<{ id: string; error: string }> = []
      for (const id of ids) {
        try {
          db.updateProfile(id, input)
          successIds.push(id)
        } catch (error) {
          failed.push({
            id,
            error: error instanceof Error ? error.message : 'Không thể cập nhật'
          })
        }
      }
      return { successIds, failed }
    }
  )

  ipcMain.handle(IPC.PROFILES_LAUNCH, (_e, id: string) => launchProfile(id))
  ipcMain.handle(IPC.PROFILES_STOP, (_e, id: string) => stopProfile(id))
  ipcMain.handle(IPC.PROFILES_BULK_LAUNCH, (_e, ids: string[]) => bulkLaunch(ids))
  ipcMain.handle(IPC.PROFILES_BULK_STOP, (_e, ids: string[]) => bulkStop(ids))
  ipcMain.handle(IPC.PROFILES_LOGIN_GMAIL, async (_e, id: string, options?: GmailLoginOptions) => {
    const { loginGmailForProfile } = await import('./gmail-login.service')
    return loginGmailForProfile(id, options)
  })
  ipcMain.handle(IPC.PROFILES_LOGIN_GMAIL_BULK, async (_e, ids: string[]) => {
    const { bulkLoginGmail } = await import('./gmail-login.service')
    return bulkLoginGmail(ids)
  })
  ipcMain.handle(IPC.PROFILES_TILE_LAYOUT, (_e, count: number) => computeTileLayout(count))
  ipcMain.handle(IPC.PROFILES_ARRANGE_WINDOWS, async (_e, ids: string[]) => {
    await arrangeProfileWindows(ids)
    return true
  })

  ipcMain.handle(IPC.GMAIL_LIST_LOAD, async () => {
    const { loadGmailList, getGmailListPath } = await import('./gmail-list.service')
    return { content: loadGmailList(), path: getGmailListPath() }
  })
  ipcMain.handle(IPC.GMAIL_LIST_SAVE, async (_e, content: string) => {
    const { saveGmailList } = await import('./gmail-list.service')
    return saveGmailList(content)
  })
  ipcMain.handle(IPC.GMAIL_FAILED_LOAD, async () => {
    const { loadFailedGmailEmails } = await import('./gmail-list.service')
    return loadFailedGmailEmails()
  })
  ipcMain.handle(IPC.GMAIL_FAILED_SAVE, async (_e, emails: string[]) => {
    const { saveFailedGmailEmails } = await import('./gmail-list.service')
    return saveFailedGmailEmails(emails)
  })
  ipcMain.handle(IPC.GMAIL_SETUP_LOAD, async () => {
    const { loadGmailSetup } = await import('./gmail-list.service')
    return loadGmailSetup()
  })
  ipcMain.handle(IPC.GMAIL_SETUP_SAVE, async (_e, config) => {
    const { saveGmailSetup } = await import('./gmail-list.service')
    return saveGmailSetup(config)
  })
  ipcMain.handle(IPC.DIALOG_OPEN_IMAGE, async () => {
    const { dialog, BrowserWindow } = await import('electron')
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Chọn ảnh đại diện',
          properties: ['openFile'],
          filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }
          ]
        })
      : await dialog.showOpenDialog({
          title: 'Chọn ảnh đại diện',
          properties: ['openFile'],
          filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }
          ]
        })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.FILE_IMAGE_PREVIEW, async (_e, filePath: string): Promise<ImagePreview> => {
    const empty: ImagePreview = { exists: false, dataUrl: '', size: 0, name: '' }
    if (!isAllowedImagePath(filePath)) return empty

    const { readFileSync, statSync } = await import('fs')
    const { extname, resolve } = await import('path')
    const target = resolve(filePath.trim())

    try {
      const stat = statSync(target)
      const name = safeBasename(target)
      // Ảnh quá lớn: vẫn báo hợp lệ nhưng không nhúng base64 vào renderer
      if (stat.size > 8 * 1024 * 1024) {
        return { exists: true, dataUrl: '', size: stat.size, name }
      }
      const mimeByExt: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon'
      }
      const mime = mimeByExt[extname(target).toLowerCase()]
      if (!mime) return empty
      const base64 = readFileSync(target).toString('base64')
      return { exists: true, dataUrl: `data:${mime};base64,${base64}`, size: stat.size, name }
    } catch {
      return empty
    }
  })

  ipcMain.handle(IPC.DIALOG_OPEN_SCRIPT_TEXT, async () => {
    const { dialog, BrowserWindow } = await import('electron')
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      title: 'Chọn file code Apps Script (.txt)',
      properties: ['openFile'] as ('openFile')[],
      filters: [
        { name: 'Text / Script', extensions: ['txt', 'gs', 'js'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.GROUPS_LIST, () => db.listGroups())
  ipcMain.handle(IPC.GROUPS_CREATE, (_e, input: CreateGroupInput) => db.createGroup(input))
  ipcMain.handle(IPC.GROUPS_UPDATE, (_e, id: string, input: UpdateGroupInput) =>
    db.updateGroup(id, input)
  )
  ipcMain.handle(IPC.GROUPS_DELETE, (_e, id: string) => {
    db.deleteGroup(id)
    return true
  })

  ipcMain.handle(IPC.DASHBOARD_STATS, (): DashboardStats => {
    const profiles = db.listProfiles()
    const groups = db.listGroups()
    const groupMap = new Map(groups.map((g) => [g.id, g.name]))

    const groupBreakdownMap = new Map<string | null, { count: number; withGmail: number }>()
    let withGmail = 0
    let withProxy = 0
    let runningProfiles = 0
    let idleProfiles = 0
    let errorProfiles = 0
    let startingOrStopping = 0

    for (const p of profiles) {
      const hasMail = hasGmailCredentials(p.gmail)
      if (hasMail) withGmail += 1
      if (p.proxy?.type && p.proxy.type !== 'none') withProxy += 1

      if (p.status === 'running') runningProfiles += 1
      else if (p.status === 'idle') idleProfiles += 1
      else if (p.status === 'error') errorProfiles += 1
      else if (p.status === 'starting' || p.status === 'stopping') startingOrStopping += 1

      const bucket = groupBreakdownMap.get(p.groupId) ?? { count: 0, withGmail: 0 }
      bucket.count += 1
      if (hasMail) bucket.withGmail += 1
      groupBreakdownMap.set(p.groupId, bucket)
    }

    return sanitizeDashboardStats({
      totalProfiles: profiles.length,
      runningProfiles,
      idleProfiles,
      totalGroups: groups.length,
      withGmail,
      withoutGmail: profiles.length - withGmail,
      withProxy,
      errorProfiles,
      startingOrStopping,
      recentlyLaunched: [...profiles]
        .filter((p) => p.lastLaunchedAt)
        .sort((a, b) => String(b.lastLaunchedAt).localeCompare(String(a.lastLaunchedAt)))
        .slice(0, 8),
      groupBreakdown: [...groupBreakdownMap.entries()]
        .map(([groupId, { count, withGmail: gmailCount }]) => ({
          groupId,
          groupName: groupId ? (groupMap.get(groupId) ?? 'Không rõ') : 'Chưa nhóm',
          count,
          withGmail: gmailCount
        }))
        .sort((a, b) => b.count - a.count)
    })
  })

  ipcMain.handle(IPC.SETTINGS_GET, () => db.getSettings())
  ipcMain.handle(IPC.SETTINGS_UPDATE, (_e, patch: Partial<AppSettings>) => db.updateSettings(patch))
  ipcMain.handle(IPC.SETTINGS_DETECT_CHROME, () => {
    const path = detectChromePath()
    if (path) db.updateSettings({ chromePath: path })
    return path
  })
}
