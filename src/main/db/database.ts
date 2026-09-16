import { app } from 'electron'
import { spawnSync } from 'child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
  toCreateProfileInput,
  type ImportGroupsPayload,
  type ImportGroupsResult
} from '../../shared/group-import'
import {
  decideImportMode,
  looksLikeUuid,
  parseStoreSnapshot,
  type DataImportOptions,
  type DataImportPreview,
  type DataImportResult
} from '../../shared/data-import'
import {
  chromeSessionFingerprint,
  chromeUserDataLooksPopulated,
  listFoldersForLayout,
  listProfileFolders,
  resolveDataImportLayout
} from '../utils/data-import-fs'
import {
  decryptProfileFromDisk,
  encryptProfileForDisk
} from '../utils/credentials'
import {
  getDataRoot,
  getDefaultProfilesRoot,
  getProjectRoot,
  migrateLegacyDataDir
} from '../utils/paths'
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
    this.adoptOrphanChromeFolders()
    this.persistImmediate()
  }

  private portableDbPath(): string {
    return join(getDataRoot(), 'chrome-manager-db.json')
  }

  private readStoreFile(path: string): StoreData | null {
    if (!existsSync(path)) return null
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoreData
      const profiles = (parsed.profiles ?? []).map((p) =>
        decryptProfileFromDisk(p as ChromeProfile)
      )
      return {
        profiles,
        groups: parsed.groups ?? [],
        settings: { ...defaultSettings(), ...(parsed.settings ?? {}) }
      }
    } catch {
      return null
    }
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
    const fromAppData = this.readStoreFile(this.filePath)
    if (fromAppData && fromAppData.profiles.length > 0) return fromAppData

    const fromPortable = this.readStoreFile(this.portableDbPath())
    if (fromPortable && fromPortable.profiles.length > 0) {
      return fromPortable
    }

    if (fromAppData) return fromAppData
    if (fromPortable) return fromPortable

    const initial = this.createEmptyStore()
    this.persistImmediate(initial)
    return initial
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
    this.writePortableCopy(payload)
  }

  /** Bản sao trong data/ — copy cả project sang máy khác vẫn còn tên nhóm/hồ sơ. */
  private writePortableCopy(payload: string): void {
    try {
      const portable = this.portableDbPath()
      const dir = getDataRoot()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmp = `${portable}.tmp`
      writeFileSync(tmp, payload, 'utf-8')
      try {
        renameSync(tmp, portable)
      } catch {
        writeFileSync(portable, payload, 'utf-8')
        rmSync(tmp, { force: true })
      }
    } catch (error) {
      console.error('[Database] Không ghi được bản portable', error)
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

  /**
   * Gắn dataDir đúng thư mục UUID; nếu DB chưa có hồ sơ thì nhận toàn bộ folder.
   */
  private adoptOrphanChromeFolders(): boolean {
    const root = resolve(this.getSettings().profilesRoot)
    if (!existsSync(root)) return false
    const folders = listProfileFolders(root)
    let changed = false

    for (const folderName of folders) {
      const dir = join(root, folderName)
      const found = this.data.profiles.find((p) => p.id === folderName)
      if (found) {
        const nextDir = resolve(found.dataDir || dir)
        if (nextDir !== resolve(dir) && !chromeUserDataLooksPopulated(nextDir) && existsSync(dir)) {
          found.dataDir = dir
          found.updatedAt = new Date().toISOString()
          changed = true
        }
      }
    }

    if (this.data.profiles.length > 0) return changed

    let index = 0
    for (const folderName of folders) {
      if (this.data.profiles.some((p) => p.id === folderName)) continue
      index += 1
      try {
        this.importProfileRecord({
          id: folderName,
          name: `Profile ${String(index).padStart(2, '0')}`,
          notes: '',
          groupId: null,
          userAgent: this.getSettings().defaultUserAgent,
          proxy: { ...DEFAULT_PROXY },
          homepage: 'chrome://newtab/',
          tags: [],
          gmail: null,
          autoLoginGmail: false,
          dataDir: join(root, folderName),
          ensureEmptyDir: false
        })
        changed = true
      } catch {
        // ignore
      }
    }
    return changed
  }

  private copyChromeUserDataDir(
    sourceDir: string,
    destDir: string,
    replace = false
  ): boolean {
    const src = resolve(sourceDir)
    const dst = resolve(destDir)
    if (src === dst) return true
    mkdirSync(this.getSettings().profilesRoot, { recursive: true })
    if (existsSync(dst)) {
      if (
        !replace &&
        chromeUserDataLooksPopulated(dst) &&
        chromeUserDataLooksPopulated(src)
      ) {
        return false
      }
      if (replace || !chromeUserDataLooksPopulated(dst)) {
        try {
          rmSync(dst, { recursive: true, force: true })
        } catch (error) {
          throw new Error(
            `Không xóa được thư mục ${dst}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      } else {
        return true
      }
    }
    this.copyTreeBestEffort(src, dst)
    return true
  }

  private copyTreeBestEffort(src: string, dst: string): void {
    mkdirSync(dst, { recursive: true })
    if (process.platform === 'win32') {
      const result = spawnSync(
        'robocopy',
        [src, dst, '/E', '/COPY:DAT', '/R:3', '/W:1', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS'],
        { windowsHide: true, encoding: 'utf8' }
      )
      const code = result.status ?? 16
      // robocopy: 0–7 = thành công (có copy / extra / mismatch)
      if (code >= 8) {
        throw new Error(
          `Không copy được hồ sơ Chrome (mã ${code}). Đóng Chrome đang dùng thư mục nguồn rồi thử lại.`
        )
      }
    } else {
      const skip = new Set([
        'SingletonLock',
        'SingletonSocket',
        'SingletonCookie',
        'DevToolsActivePort'
      ])
      let copied = 0
      const walk = (from: string, to: string) => {
        mkdirSync(to, { recursive: true })
        let entries
        try {
          entries = readdirSync(from, { withFileTypes: true })
        } catch (error) {
          throw new Error(
            `Không đọc được "${from}": ${error instanceof Error ? error.message : String(error)}`
          )
        }
        for (const entry of entries) {
          if (skip.has(entry.name)) continue
          const a = join(from, entry.name)
          const b = join(to, entry.name)
          try {
            if (entry.isDirectory()) walk(a, b)
            else {
              cpSync(a, b)
              copied += 1
            }
          } catch {
            // File đang bị Chrome khóa — bỏ qua, copy phần còn lại.
          }
        }
      }
      walk(src, dst)
      if (copied === 0) {
        throw new Error(
          `Không copy được file nào từ "${src}". Đóng Chrome đang dùng thư mục này rồi thử lại.`
        )
      }
    }
    this.assertCopiedSession(src, dst)
  }

  private assertCopiedSession(src: string, dst: string): void {
    const missing: string[] = []
    const need = (label: string, rel: string) => {
      const from = join(src, rel)
      const to = join(dst, rel)
      try {
        if (!existsSync(from) || statSync(from).size < 32) return
        if (!existsSync(to) || statSync(to).size < 32) missing.push(label)
      } catch {
        missing.push(label)
      }
    }
    need('Local State', join('Local State'))
    need('Preferences', join('Default', 'Preferences'))
    need('Cookies', join('Default', 'Network', 'Cookies'))
    if (!existsSync(join(src, 'Default', 'Network', 'Cookies'))) {
      need('Cookies', join('Default', 'Cookies'))
    }
    need('Login Data', join('Default', 'Login Data'))
    const srcSess = join(src, 'Default', 'Sessions')
    const dstSess = join(dst, 'Default', 'Sessions')
    try {
      const hasSession = (dir: string) =>
        existsSync(dir) &&
        readdirSync(dir).some((n) => n.startsWith('Session') || n.startsWith('Tabs'))
      if (hasSession(srcSess) && !hasSession(dstSess)) missing.push('Sessions')
    } catch {
      missing.push('Sessions')
    }
    if (missing.length > 0) {
      throw new Error(
        `Copy thiếu ${[...new Set(missing)].join(', ')}. Đóng Chrome đang mở thư mục nguồn rồi nhập lại.`
      )
    }
  }

  getSettings(): AppSettings {
    return { ...this.data.settings }
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...patch }
    if (patch.maxConcurrentLaunches != null) {
      const n = Math.floor(Number(patch.maxConcurrentLaunches)) || 1
      this.data.settings.maxConcurrentLaunches = Math.min(25, Math.max(1, n))
    }
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
    const toRemove = this.data.profiles.filter((p) => p.groupId === id)
    this.data.groups = this.data.groups.filter((g) => g.id !== id)
    this.data.profiles = this.data.profiles.filter((p) => p.groupId !== id)
    this.persist()
    for (const profile of toRemove) {
      if (profile.dataDir) this.safeRemoveDataDir(profile.dataDir)
    }
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

  /**
   * Nhập nhóm kèm hồ sơ. Luôn tạo id / dataDir mới.
   * Hồ sơ trùng email Gmail sẽ bị bỏ qua (không hủy cả lần nhập).
   */
  importGroups(payload: ImportGroupsPayload): ImportGroupsResult {
    const skipped: ImportGroupsResult['skipped'] = []
    const groupIds: string[] = []
    let profilesCreated = 0

    for (const item of payload.groups) {
      const group = this.createGroup({
        name: item.name,
        color: item.color,
        description: item.description,
        restoreLastSession: item.restoreLastSession
      })
      groupIds.push(group.id)

      for (const profileItem of item.profiles ?? []) {
        try {
          const input = toCreateProfileInput(profileItem, group.id)
          this.createProfile(input)
          profilesCreated += 1
        } catch (error) {
          skipped.push({
            groupName: group.name,
            profileName: profileItem.name,
            reason: error instanceof Error ? error.message : 'Không thể tạo hồ sơ'
          })
        }
      }
    }

    return {
      groupsCreated: groupIds.length,
      profilesCreated,
      skipped,
      groupIds
    }
  }

  /** Xem trước khi nhập từ thư mục chrome-profiles / data / file db. */
  previewDataImport(selectedPath: string): DataImportPreview {
    const layout = this.enrichImportLayout(resolveDataImportLayout(selectedPath))
    const folders = listFoldersForLayout(layout)
    const existingIds = new Set(this.data.profiles.map((p) => p.id))
    const orphanFolderCount = folders.filter((name) => !existingIds.has(name)).length
    const destRoot = resolve(this.getSettings().profilesRoot)
    const alreadyPresentNames = folders
      .map((name) => this.data.profiles.find((p) => p.id === name))
      .filter((p): p is ChromeProfile => {
        if (!p) return false
        const dir = p.dataDir ? resolve(p.dataDir) : join(destRoot, p.id)
        return chromeUserDataLooksPopulated(dir)
      })
      .map((p) => p.name)
    const healCount = this.data.profiles.filter((p) => {
      const folder = join(layout.profilesDir, p.id)
      const current = p.dataDir ? resolve(p.dataDir) : ''
      return (
        chromeUserDataLooksPopulated(folder) &&
        (!current || current !== resolve(folder) || !chromeUserDataLooksPopulated(current))
      )
    }).length

    const snapshot = this.readImportSnapshot(layout)
    const sameRoot = resolve(layout.profilesDir) === destRoot
    const useSnapshot = Boolean(snapshot && (!sameRoot || this.data.profiles.length === 0))
    const mode = useSnapshot
      ? decideImportMode(snapshot, folders.length)
      : ('folders' as const)

    return {
      layout,
      mode,
      groupCount: useSnapshot ? (snapshot?.groups.length ?? 0) : 0,
      profileCount: useSnapshot
        ? (snapshot?.profiles.filter((p) => !existingIds.has(p.id)).length ?? 0)
        : orphanFolderCount,
      folderCount: folders.length,
      orphanFolderCount,
      healCount,
      alreadyPresentCount: alreadyPresentNames.length,
      alreadyPresentNames: alreadyPresentNames.slice(0, 8),
      dbFound: Boolean(layout.dbPath),
      groupNames: useSnapshot ? (snapshot?.groups ?? []).map((g) => g.name).slice(0, 8) : []
    }
  }

  private enrichImportLayout(layout: ReturnType<typeof resolveDataImportLayout>) {
    if (layout.dbPath && existsSync(layout.dbPath)) return layout
    const destRoot = resolve(this.getSettings().profilesRoot)
    const sameTree =
      resolve(layout.profilesDir) === destRoot ||
      resolve(layout.root) === resolve(getDataRoot())
    if (!sameTree) return layout
    const portable = this.portableDbPath()
    if (existsSync(portable)) return { ...layout, dbPath: portable }
    return layout
  }

  private readImportSnapshot(layout: ReturnType<typeof resolveDataImportLayout>) {
    const path = layout.dbPath
    if (!path || !existsSync(path)) return null
    if (resolve(path) === resolve(this.filePath)) return null
    try {
      const snapshot = parseStoreSnapshot(readFileSync(path, 'utf8'))
      if (!snapshot) return null
      return {
        groups: snapshot.groups,
        profiles: snapshot.profiles.map((p) => decryptProfileFromDisk(p))
      }
    } catch {
      return null
    }
  }

  /**
   * Nhập từ thư mục chrome-profiles (kèm chrome-manager-db.json nếu có).
   * Gắn / copy session Chrome; hồ sơ đã có thì chữa dataDir trống.
   */
  importFromDataPath(
    selectedPath: string,
    options: DataImportOptions = {}
  ): DataImportResult {
    const layout = this.enrichImportLayout(resolveDataImportLayout(selectedPath))
    const destRoot = resolve(this.getSettings().profilesRoot)
    const sourceRoot = resolve(layout.profilesDir)
    const folders = listFoldersForLayout(layout)
    const existingIds = new Set(this.data.profiles.map((p) => p.id))
    const sameRoot = sourceRoot === destRoot
    const snapshot = this.readImportSnapshot(layout)
    const useSnapshot = Boolean(snapshot && (!sameRoot || this.data.profiles.length === 0))
    const mode = useSnapshot
      ? decideImportMode(snapshot, folders.length)
      : ('folders' as const)

    const skipped: DataImportResult['skipped'] = []
    let groupsCreated = 0
    let profilesCreated = 0
    let profilesHealed = 0
    let dirsCopied = 0
    let dirsLinked = 0
    let alreadyPresent = 0
    const readyNames: string[] = []
    const groupIdMap = new Map<string, string>()
    const fallbackGroupId = this.resolveImportGroupId(options.groupId)

    if (useSnapshot && mode === 'groups' && snapshot) {
      for (const g of snapshot.groups) {
        const already = this.data.groups.find(
          (x) => x.id === g.id || x.name.trim().toLowerCase() === g.name.trim().toLowerCase()
        )
        if (already) {
          groupIdMap.set(g.id, already.id)
          continue
        }
        try {
          const created = this.createGroup({
            name: g.name,
            color: g.color,
            description: g.description,
            restoreLastSession: g.restoreLastSession
          })
          groupIdMap.set(g.id, created.id)
          groupsCreated += 1
        } catch (error) {
          skipped.push({
            name: g.name,
            reason: error instanceof Error ? error.message : 'Không tạo được nhóm'
          })
        }
      }
    }

    const snapshotProfiles = useSnapshot && snapshot?.profiles.length ? snapshot.profiles : null
    const profilesToImport: Array<Partial<ChromeProfile> & { id: string; name: string }> =
      snapshotProfiles
        ? snapshotProfiles
        : folders.map((folderName, index) => ({
            id: folderName,
            name: looksLikeUuid(folderName)
              ? folderName.slice(0, 8)
              : `Profile ${String(index + 1).padStart(2, '0')}`,
            notes: '',
            groupId: fallbackGroupId,
            userAgent: this.getSettings().defaultUserAgent,
            proxy: { ...DEFAULT_PROXY },
            dataDir: join(sourceRoot, folderName),
            homepage: 'chrome://newtab/',
            tags: [],
            gmail: null,
            autoLoginGmail: false
          }))

    const seen = new Set<string>()
    for (const source of profilesToImport) {
      seen.add(source.id)
      try {
        const mappedGroupId =
          source.groupId && groupIdMap.has(source.groupId)
            ? groupIdMap.get(source.groupId)!
            : source.groupId && this.data.groups.some((g) => g.id === source.groupId)
              ? source.groupId
              : fallbackGroupId

        const candidates = [
          join(sourceRoot, source.id),
          source.dataDir ? resolve(source.dataDir) : ''
        ].filter(Boolean)

        const sourceDir =
          candidates.find((p) => {
            try {
              return existsSync(p) && statSync(p).isDirectory()
            } catch {
              return false
            }
          }) ?? null

        const destDir = join(destRoot, source.id)
        const existing = this.data.profiles.find((p) => p.id === source.id)

        if (existing) {
          if (sourceDir && chromeUserDataLooksPopulated(sourceDir)) {
            const current = existing.dataDir ? resolve(existing.dataDir) : ''
            const attachInPlace = Boolean(layout.onlyFolderNames?.length)

            if (attachInPlace) {
              existing.dataDir = resolve(sourceDir)
              existing.updatedAt = new Date().toISOString()
              if (mappedGroupId && !existing.groupId) existing.groupId = mappedGroupId
              if (resolve(current) === resolve(sourceDir) && chromeUserDataLooksPopulated(current)) {
                alreadyPresent += 1
              } else {
                profilesHealed += 1
                dirsLinked += 1
              }
              readyNames.push(existing.name)
              continue
            }

            const forceReplace =
              resolve(sourceDir) !== resolve(destDir) &&
              chromeSessionFingerprint(sourceDir) !==
                chromeSessionFingerprint(current || destDir)

            if (resolve(sourceDir) === resolve(destDir)) {
              if (current !== destDir) {
                existing.dataDir = destDir
                existing.updatedAt = new Date().toISOString()
                profilesHealed += 1
                readyNames.push(existing.name)
              } else if (!chromeUserDataLooksPopulated(current)) {
                profilesHealed += 1
                readyNames.push(existing.name)
              } else {
                alreadyPresent += 1
                readyNames.push(existing.name)
              }
            } else if (forceReplace) {
              if (existing.status === 'running' || existing.status === 'starting') {
                skipped.push({
                  name: existing.name,
                  reason: 'Hồ sơ đang chạy — đóng Chrome rồi nhập lại để ghi đè session'
                })
              } else if (this.copyChromeUserDataDir(sourceDir, destDir, true)) {
                existing.dataDir = destDir
                existing.updatedAt = new Date().toISOString()
                profilesHealed += 1
                dirsCopied += 1
                readyNames.push(existing.name)
              }
            } else if (
              !current ||
              !existsSync(current) ||
              !chromeUserDataLooksPopulated(current)
            ) {
              if (this.copyChromeUserDataDir(sourceDir, destDir)) {
                existing.dataDir = destDir
                existing.updatedAt = new Date().toISOString()
                profilesHealed += 1
                dirsCopied += 1
                readyNames.push(existing.name)
              } else if (chromeUserDataLooksPopulated(destDir)) {
                existing.dataDir = destDir
                existing.updatedAt = new Date().toISOString()
                profilesHealed += 1
                dirsLinked += 1
                readyNames.push(existing.name)
              }
            } else {
              alreadyPresent += 1
              readyNames.push(existing.name)
            }

            if (mappedGroupId && !existing.groupId) {
              existing.groupId = mappedGroupId
              existing.updatedAt = new Date().toISOString()
              profilesHealed += 1
            }
          } else {
            alreadyPresent += 1
            readyNames.push(existing.name)
            if (mappedGroupId && !existing.groupId) {
              existing.groupId = mappedGroupId
              existing.updatedAt = new Date().toISOString()
              profilesHealed += 1
            }
          }
          continue
        }

        if (!sourceDir) {
          this.importProfileRecord({
            id: source.id,
            name: source.name,
            notes: source.notes,
            groupId: mappedGroupId,
            userAgent: source.userAgent,
            proxy: source.proxy,
            homepage: source.homepage,
            tags: source.tags,
            gmail: source.gmail ?? null,
            autoLoginGmail: source.autoLoginGmail,
            dataDir: destDir,
            ensureEmptyDir: true
          })
          existingIds.add(source.id)
          profilesCreated += 1
          skipped.push({
            name: source.name,
            reason: 'Không thấy thư mục Chrome — đã tạo hồ sơ trống'
          })
          continue
        }

        const resolvedSource = resolve(sourceDir)
        const resolvedDest = resolve(destDir)

        if (resolvedSource === resolvedDest || resolvedSource.startsWith(destRoot + sep)) {
          this.importProfileRecord({
            id: source.id,
            name: source.name,
            notes: source.notes,
            groupId: mappedGroupId,
            userAgent: source.userAgent,
            proxy: source.proxy,
            homepage: source.homepage,
            tags: source.tags,
            gmail: source.gmail ?? null,
            autoLoginGmail: source.autoLoginGmail,
            dataDir: resolvedSource.startsWith(destRoot + sep) ? resolvedSource : destDir,
            ensureEmptyDir: false
          })
          dirsLinked += 1
        } else if (layout.onlyFolderNames?.length) {
          // Gắn đúng thư mục UUID đã chọn — giữ cookie/tab, không copy thiếu file khóa.
          this.importProfileRecord({
            id: source.id,
            name: source.name,
            notes: source.notes,
            groupId: mappedGroupId,
            userAgent: source.userAgent,
            proxy: source.proxy,
            homepage: source.homepage,
            tags: source.tags,
            gmail: source.gmail ?? null,
            autoLoginGmail: source.autoLoginGmail,
            dataDir: resolvedSource,
            ensureEmptyDir: false
          })
          dirsLinked += 1
        } else {
          const copied = this.copyChromeUserDataDir(sourceDir, destDir)
          if (copied) dirsCopied += 1
          else dirsLinked += 1
          this.importProfileRecord({
            id: source.id,
            name: source.name,
            notes: source.notes,
            groupId: mappedGroupId,
            userAgent: source.userAgent,
            proxy: source.proxy,
            homepage: source.homepage,
            tags: source.tags,
            gmail: source.gmail ?? null,
            autoLoginGmail: source.autoLoginGmail,
            dataDir: destDir,
            ensureEmptyDir: false
          })
        }

        existingIds.add(source.id)
        profilesCreated += 1
        readyNames.push(source.name)
      } catch (error) {
        skipped.push({
          name: source.name || source.id,
          reason: error instanceof Error ? error.message : 'Không nhập được hồ sơ'
        })
      }
    }

    // Snapshot không liệt kê hết folder UUID → vẫn gắn thư mục mồ côi
    for (const folderName of folders) {
      if (seen.has(folderName) || existingIds.has(folderName)) continue
      try {
        this.importProfileRecord({
          id: folderName,
          name: looksLikeUuid(folderName)
            ? folderName.slice(0, 8)
            : `Profile ${String(this.data.profiles.length + 1).padStart(2, '0')}`,
          notes: '',
          groupId: fallbackGroupId,
          userAgent: this.getSettings().defaultUserAgent,
          proxy: { ...DEFAULT_PROXY },
          homepage: 'chrome://newtab/',
          tags: [],
          gmail: null,
          autoLoginGmail: false,
          dataDir: join(sourceRoot, folderName),
          ensureEmptyDir: false
        })
        existingIds.add(folderName)
        profilesCreated += 1
        dirsLinked += 1
        readyNames.push(looksLikeUuid(folderName) ? folderName.slice(0, 8) : folderName)
      } catch (error) {
        skipped.push({
          name: folderName,
          reason: error instanceof Error ? error.message : 'Không gắn được thư mục'
        })
      }
    }

    this.persistImmediate()

    return {
      mode,
      groupsCreated,
      profilesCreated,
      profilesHealed,
      dirsCopied,
      dirsLinked,
      alreadyPresent,
      readyNames: [...new Set(readyNames)],
      skipped
    }
  }

  private resolveImportGroupId(groupId?: string | null): string | null {
    const id = groupId?.trim() ?? ''
    if (!id || id === 'all' || id === 'ungrouped') return null
    return this.data.groups.some((g) => g.id === id) ? id : null
  }

  /** Ghi hồ sơ đã có dataDir (không tạo thư mục mới trừ khi yêu cầu). */
  private importProfileRecord(input: {
    id: string
    name: string
    notes?: string
    groupId?: string | null
    userAgent?: string
    proxy?: ChromeProfile['proxy']
    homepage?: string
    tags?: string[]
    gmail?: ChromeProfile['gmail']
    autoLoginGmail?: boolean
    dataDir: string
    ensureEmptyDir: boolean
  }): ChromeProfile {
    if (this.data.profiles.some((p) => p.id === input.id)) {
      throw new Error(`Hồ sơ id ${input.id} đã tồn tại`)
    }
    const now = new Date().toISOString()
    const settings = this.getSettings()
    if (input.ensureEmptyDir && !existsSync(input.dataDir)) {
      mkdirSync(input.dataDir, { recursive: true })
    }
    const gmail = normalizeGmail(input.gmail)
    this.assertGmailUnique(gmail, input.id)

    const profile: ChromeProfile = {
      id: input.id,
      name: (input.name || 'Profile').trim(),
      notes: input.notes?.trim() ?? '',
      groupId: input.groupId ?? null,
      userAgent: input.userAgent?.trim() || settings.defaultUserAgent,
      proxy: { ...DEFAULT_PROXY, ...(input.proxy ?? {}) },
      dataDir: input.dataDir,
      homepage: input.homepage?.trim() || 'chrome://newtab/',
      tags: input.tags ?? [],
      gmail,
      autoLoginGmail: Boolean(input.autoLoginGmail),
      status: 'idle',
      lastLaunchedAt: null,
      createdAt: now,
      updatedAt: now
    }
    this.data.profiles.push(profile)
    return this.normalizeProfile(profile)
  }
}

let db: Database | null = null

export function getDb(): Database {
  if (!db) db = new Database()
  return db
}
