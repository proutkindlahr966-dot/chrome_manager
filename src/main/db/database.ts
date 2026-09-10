import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join, resolve, sep } from 'path'
import { v4 as uuid } from 'uuid'
import {
  AppSettings,
  BulkCreateProfileInput,
  ChromeProfile,
  CreateGroupInput,
  CreateProfileInput,
  DEFAULT_PROXY,
  DEFAULT_USER_AGENT,
  GROUP_COLORS,
  ProfileGroup,
  ProfileStatus,
  UpdateGroupInput,
  UpdateProfileInput
} from '../../shared/types'
import { normalizeGmail } from '../../shared/gmail'
import {
  decryptProfileFromDisk,
  encryptProfileForDisk
} from '../utils/credentials'
import { getDefaultProfilesRoot, getProjectRoot, migrateLegacyDataDir } from '../utils/paths'
import { isPathInside } from '../utils/path-guard'

interface StoreData {
  profiles: ChromeProfile[]
  groups: ProfileGroup[]
  settings: AppSettings
}

function defaultSettings(): AppSettings {
  return {
    chromePath: '',
    profilesRoot: getDefaultProfilesRoot(),
    theme: 'system',
    defaultUserAgent: DEFAULT_USER_AGENT,
    closeOnExit: true,
    maxConcurrentLaunches: 5
  }
}

export class Database {
  private filePath: string
  private data: StoreData
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor() {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, 'chrome-manager-db.json')
    this.data = this.load()
    this.migrateProfilesRootIfNeeded()
    this.ensureProfilesRoot()
  }

  /** Chuyển profilesRoot legacy (userData / project root / ổ cũ) → data/chrome-profiles */
  private migrateProfilesRootIfNeeded(): void {
    migrateLegacyDataDir('chrome-profiles')
    migrateLegacyDataDir('debug-screenshots')

    const desired = resolve(getDefaultProfilesRoot())
    const currentResolved = this.data.settings.profilesRoot
      ? resolve(this.data.settings.profilesRoot)
      : ''

    const legacyPrefixes = [
      currentResolved,
      resolve(join(app.getPath('userData'), 'chrome-profiles')),
      resolve(join(getProjectRoot(), 'chrome-profiles'))
    ].filter((p, i, arr) => p && arr.indexOf(p) === i)

    let changed = false

    this.data.profiles = this.data.profiles.map((profile) => {
      const next = this.resolveProfileDataDir(profile, desired, legacyPrefixes)
      if (next.dataDir !== profile.dataDir) changed = true
      return next
    })

    if (this.data.settings.profilesRoot !== desired) {
      this.data.settings.profilesRoot = desired
      changed = true
    }

    if (changed) this.persistImmediate()
  }

  /** Sửa dataDir khi project/ổ đĩa đổi hoặc thư mục cũ không còn tồn tại. */
  private resolveProfileDataDir(
    profile: ChromeProfile,
    desiredRoot: string,
    legacyPrefixes: string[]
  ): ChromeProfile {
    const targetById = join(desiredRoot, profile.id)
    const currentDir = resolve(profile.dataDir)

    if (currentDir === targetById) return profile

    for (const prefix of legacyPrefixes) {
      if (currentDir === prefix || currentDir.startsWith(prefix + sep)) {
        const relative = currentDir.slice(prefix.length).replace(/^[\\/]+/, '')
        return {
          ...profile,
          dataDir: relative ? join(desiredRoot, relative) : targetById
        }
      }
    }

    if (!existsSync(currentDir)) {
      return { ...profile, dataDir: targetById }
    }

    return profile
  }

  private load(): StoreData {
    if (!existsSync(this.filePath)) {
      const initial = this.createEmptyStore()
      this.persistImmediate(initial)
      return initial
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as StoreData
      const profiles = (parsed.profiles ?? []).map((p) =>
        decryptProfileFromDisk(p as ChromeProfile)
      )
      return {
        profiles,
        groups: parsed.groups ?? [],
        settings: { ...defaultSettings(), ...(parsed.settings ?? {}) }
      }
    } catch (error) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = `${this.filePath}.corrupt-${stamp}`
      try {
        copyFileSync(this.filePath, backupPath)
        console.error(`[Database] File hỏng — đã backup: ${backupPath}`, error)
      } catch (backupError) {
        console.error('[Database] Không thể backup file hỏng', backupError)
      }
      const empty = this.createEmptyStore()
      this.persistImmediate(empty)
      return empty
    }
  }

  private createEmptyStore(): StoreData {
    const now = new Date().toISOString()
    return {
      profiles: [],
      groups: [
        {
          id: uuid(),
          name: 'Mặc định',
          color: GROUP_COLORS[0],
          description: 'Nhóm hồ sơ mặc định',
          restoreLastSession: true,
          createdAt: now,
          updatedAt: now
        }
      ],
      settings: defaultSettings()
    }
  }

  private serialize(data: StoreData): StoreData {
    return {
      ...data,
      profiles: data.profiles.map(encryptProfileForDisk)
    }
  }

  private persistImmediate(data = this.data): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.dirty = false
    const payload = JSON.stringify(this.serialize(data), null, 2)
    const tmpPath = `${this.filePath}.tmp`
    writeFileSync(tmpPath, payload, 'utf-8')
    try {
      renameSync(tmpPath, this.filePath)
    } catch {
      // Windows: rename có thể fail nếu đích đang mở — fallback ghi trực tiếp
      writeFileSync(this.filePath, payload, 'utf-8')
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // ignore
      }
    }
  }

  /** Debounce ghi đĩa cho các cập nhật status liên tục. */
  private persistDebounced(): void {
    this.dirty = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      if (this.dirty) this.persistImmediate()
    }, 400)
  }

  private persist(data = this.data): void {
    this.persistImmediate(data)
  }

  /** Flush mọi thay đổi đang chờ — gọi trước khi thoát app. */
  flush(): void {
    if (this.dirty || this.persistTimer) {
      this.persistImmediate()
    }
  }

  private ensureProfilesRoot(): void {
    const root = this.data.settings.profilesRoot
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
  }

  getSettings(): AppSettings {
    return { ...this.data.settings }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...patch }
    this.ensureProfilesRoot()
    this.persist()
    return this.getSettings()
  }

  listGroups(): ProfileGroup[] {
    return [...this.data.groups]
      .map((g) => this.normalizeGroup(g))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
  }

  getGroup(id: string): ProfileGroup | undefined {
    const group = this.data.groups.find((g) => g.id === id)
    return group ? this.normalizeGroup(group) : undefined
  }

  private normalizeGroup(group: ProfileGroup): ProfileGroup {
    return {
      ...group,
      restoreLastSession: group.restoreLastSession !== false
    }
  }

  createGroup(input: CreateGroupInput): ProfileGroup {
    const now = new Date().toISOString()
    const group: ProfileGroup = {
      id: uuid(),
      name: input.name.trim(),
      color: input.color ?? GROUP_COLORS[this.data.groups.length % GROUP_COLORS.length],
      description: input.description?.trim() ?? '',
      restoreLastSession: input.restoreLastSession !== false,
      createdAt: now,
      updatedAt: now
    }
    this.data.groups.push(group)
    this.persist()
    return this.normalizeGroup(group)
  }

  updateGroup(id: string, input: UpdateGroupInput): ProfileGroup {
    const index = this.data.groups.findIndex((g) => g.id === id)
    if (index < 0) throw new Error('Không tìm thấy nhóm')
    const current = this.normalizeGroup(this.data.groups[index])
    const updated: ProfileGroup = {
      ...current,
      name: input.name?.trim() ?? current.name,
      color: input.color ?? current.color,
      description: input.description !== undefined ? input.description.trim() : current.description,
      restoreLastSession:
        input.restoreLastSession !== undefined
          ? Boolean(input.restoreLastSession)
          : current.restoreLastSession,
      updatedAt: new Date().toISOString()
    }
    this.data.groups[index] = updated
    this.persist()
    return updated
  }

  deleteGroup(id: string): void {
    this.data.groups = this.data.groups.filter((g) => g.id !== id)
    this.data.profiles = this.data.profiles.map((p) =>
      p.groupId === id ? { ...p, groupId: null, updatedAt: new Date().toISOString() } : p
    )
    this.persist()
  }

  listProfiles(): ChromeProfile[] {
    return this.data.profiles.map((p) => this.normalizeProfile(p))
  }

  private normalizeProfile(profile: ChromeProfile): ChromeProfile {
    const { restoreLastSession: _legacy, ...rest } = profile as ChromeProfile & {
      restoreLastSession?: boolean
    }
    return {
      ...rest,
      gmail: normalizeGmail(profile.gmail),
      autoLoginGmail: Boolean(profile.autoLoginGmail)
    }
  }

  getProfile(id: string): ChromeProfile | undefined {
    const profile = this.data.profiles.find((p) => p.id === id)
    return profile ? this.normalizeProfile(profile) : undefined
  }

  createProfile(input: CreateProfileInput): ChromeProfile {
    const created = this.buildProfile(input)
    this.data.profiles.push(created)
    this.persist()
    return created
  }

  createProfiles(input: BulkCreateProfileInput): ChromeProfile[] {
    const count = Math.min(500, Math.max(1, Math.floor(input.count) || 1))
    const startIndex = Math.max(1, Math.floor(input.startIndex ?? 1))
    const baseName = input.name.trim() || 'Profile'
    const pad = Math.max(2, String(startIndex + count - 1).length)
    const created: ChromeProfile[] = []
    const proxyList = input.proxyList

    for (let i = 0; i < count; i++) {
      const index = startIndex + i
      const proxyForProfile =
        proxyList && proxyList.length > 0
          ? proxyList[i]
            ? { ...DEFAULT_PROXY, ...proxyList[i] }
            : { ...DEFAULT_PROXY }
          : input.proxy
            ? { ...DEFAULT_PROXY, ...input.proxy }
            : undefined

      const profile = this.buildProfile({
        ...input,
        name: `${baseName} ${String(index).padStart(pad, '0')}`,
        proxy: proxyForProfile
      })
      this.data.profiles.push(profile)
      created.push(profile)
    }

    this.persist()
    return created
  }

  private buildProfile(input: CreateProfileInput): ChromeProfile {
    const now = new Date().toISOString()
    const id = uuid()
    const settings = this.getSettings()
    const dataDir = join(settings.profilesRoot, id)
    mkdirSync(dataDir, { recursive: true })
    const gmail = normalizeGmail(input.gmail)
    this.assertGmailUnique(gmail, id)

    return {
      id,
      name: input.name.trim(),
      notes: input.notes?.trim() ?? '',
      groupId: input.groupId ?? null,
      userAgent: input.userAgent?.trim() || settings.defaultUserAgent,
      proxy: { ...DEFAULT_PROXY, ...(input.proxy ?? {}) },
      dataDir,
      homepage: input.homepage?.trim() || 'chrome://newtab/',
      tags: input.tags ?? [],
      gmail,
      autoLoginGmail: Boolean(input.autoLoginGmail),
      status: 'idle',
      lastLaunchedAt: null,
      createdAt: now,
      updatedAt: now
    }
  }

  /** Mỗi email chỉ được gắn 1 profile (mọi nhóm) */
  assertGmailUnique(
    gmail: { email?: string; password?: string } | null | undefined,
    exceptProfileId?: string
  ): void {
    const emailKey = (gmail?.email ?? '').trim().toLowerCase()
    if (!emailKey || !gmail?.password) return
    const conflict = this.data.profiles.find(
      (p) =>
        p.id !== exceptProfileId &&
        (p.gmail?.email ?? '').trim().toLowerCase() === emailKey &&
        Boolean(p.gmail?.password)
    )
    if (conflict) {
      throw new Error(
        `Email ${gmail.email} đã gắn hồ sơ "${conflict.name}" — mỗi mail chỉ dùng 1 profile.`
      )
    }
  }

  findProfileByGmailEmail(email: string): ChromeProfile | undefined {
    const emailKey = email.trim().toLowerCase()
    if (!emailKey) return undefined
    const found = this.data.profiles.find(
      (p) =>
        (p.gmail?.email ?? '').trim().toLowerCase() === emailKey && Boolean(p.gmail?.password)
    )
    return found ? this.normalizeProfile(found) : undefined
  }

  updateProfile(id: string, input: UpdateProfileInput): ChromeProfile {
    const index = this.data.profiles.findIndex((p) => p.id === id)
    if (index < 0) throw new Error('Không tìm thấy hồ sơ')
    const current = this.data.profiles[index]

    const nextGmail =
      input.gmail !== undefined ? normalizeGmail(input.gmail) : (current.gmail ?? null)
    this.assertGmailUnique(nextGmail, id)

    const updated: ChromeProfile = {
      ...current,
      name: input.name?.trim() ?? current.name,
      notes: input.notes !== undefined ? input.notes.trim() : current.notes,
      groupId: input.groupId !== undefined ? input.groupId : current.groupId,
      userAgent: input.userAgent?.trim() || current.userAgent,
      proxy: input.proxy ? { ...current.proxy, ...input.proxy } : current.proxy,
      homepage:
        input.homepage !== undefined
          ? input.homepage.trim() || current.homepage
          : current.homepage,
      tags: input.tags ?? current.tags,
      gmail: nextGmail,
      autoLoginGmail:
        input.autoLoginGmail !== undefined ? Boolean(input.autoLoginGmail) : current.autoLoginGmail,
      updatedAt: new Date().toISOString()
    }
    this.data.profiles[index] = updated
    this.persist()
    return updated
  }

  setProfileStatus(id: string, status: ProfileStatus, lastLaunchedAt?: string | null): ChromeProfile {
    const index = this.data.profiles.findIndex((p) => p.id === id)
    if (index < 0) throw new Error('Không tìm thấy hồ sơ')
    const current = this.data.profiles[index]
    const updated: ChromeProfile = {
      ...current,
      status,
      lastLaunchedAt: lastLaunchedAt !== undefined ? lastLaunchedAt : current.lastLaunchedAt,
      updatedAt: new Date().toISOString()
    }
    this.data.profiles[index] = updated
    this.persistDebounced()
    return updated
  }

  deleteProfile(id: string): void {
    const profile = this.data.profiles.find((p) => p.id === id)
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id)
    this.persist()
    if (profile?.dataDir) {
      this.safeRemoveDataDir(profile.dataDir)
    }
  }

  /**
   * Xóa sạch hồ sơ như mới tạo: gỡ Gmail, xóa thư mục Chrome data rồi tạo lại trống.
   * Giữ id / tên / nhóm / proxy / UA / ghi chú.
   */
  resetProfile(id: string): ChromeProfile {
    const index = this.data.profiles.findIndex((p) => p.id === id)
    if (index < 0) throw new Error('Không tìm thấy hồ sơ')
    const current = this.data.profiles[index]

    this.safeRemoveDataDir(current.dataDir)
    mkdirSync(current.dataDir, { recursive: true })

    const updated: ChromeProfile = {
      ...this.normalizeProfile(current),
      gmail: null,
      autoLoginGmail: false,
      status: 'idle',
      lastLaunchedAt: null,
      updatedAt: new Date().toISOString()
    }
    this.data.profiles[index] = updated
    this.persist()
    return updated
  }

  private safeRemoveDataDir(dataDir: string): void {
    try {
      const root = resolve(this.data.settings.profilesRoot)
      const dir = resolve(dataDir)
      if (!isPathInside(dir, root) || dir === root) return
      // Chỉ xóa thư mục con trực tiếp của profilesRoot (uuid)
      const relative = dir.slice(root.length).replace(/^[\\/]/, '')
      if (!relative || relative.includes(sep) || relative.includes('..')) return
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      console.error('[Database] Không xóa được dataDir', dataDir, error)
    }
  }

  duplicateProfile(id: string): ChromeProfile {
    const source = this.getProfile(id)
    if (!source) throw new Error('Không tìm thấy hồ sơ')
    // Không copy Gmail — mỗi email chỉ gắn 1 profile
    return this.createProfile({
      name: `${source.name} (bản sao)`,
      notes: source.notes,
      groupId: source.groupId,
      userAgent: source.userAgent,
      proxy: source.proxy,
      homepage: source.homepage,
      tags: [...source.tags],
      gmail: null,
      autoLoginGmail: false
    })
  }
}

let db: Database | null = null

export function getDb(): Database {
  if (!db) db = new Database()
  return db
}
