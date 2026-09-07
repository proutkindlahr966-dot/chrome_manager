import { create } from 'zustand'
import type {
  AppSettings,
  ChromeProfile,
  DashboardStats,
  ProfileFilters,
  ProfileGroup,
  ProfileStatusPatch,
  CreateProfileInput,
  BulkCreateProfileInput,
  UpdateProfileInput,
  CreateGroupInput,
  UpdateGroupInput,
  GmailLoginResult,
  GmailLoginOptions,
  BulkResult
} from '@shared/types'

interface AppState {
  profiles: ChromeProfile[]
  groups: ProfileGroup[]
  stats: DashboardStats | null
  settings: AppSettings | null
  selectedIds: Set<string>
  filters: ProfileFilters
  loading: boolean
  error: string | null

  setFilters: (patch: Partial<ProfileFilters>) => void
  toggleSelect: (id: string) => void
  selectAll: (ids: string[]) => void
  clearSelection: () => void
  clearError: () => void

  refreshAll: () => Promise<void>
  refreshProfiles: () => Promise<void>
  refreshGroups: () => Promise<void>
  refreshStats: () => Promise<void>
  refreshSettings: () => Promise<void>

  createProfile: (input: CreateProfileInput) => Promise<ChromeProfile>
  createProfiles: (input: BulkCreateProfileInput) => Promise<ChromeProfile[]>
  updateProfile: (id: string, input: UpdateProfileInput) => Promise<void>
  deleteProfiles: (ids: string[]) => Promise<void>
  resetProfile: (id: string) => Promise<void>
  duplicateProfile: (id: string) => Promise<void>
  launchProfiles: (ids: string[]) => Promise<BulkResult>
  stopProfiles: (ids: string[]) => Promise<BulkResult>
  bulkUpdateProfiles: (ids: string[], input: UpdateProfileInput) => Promise<void>
  loginGmail: (
    ids: string[],
    options?: GmailLoginOptions
  ) => Promise<GmailLoginResult | BulkResult>

  createGroup: (input: CreateGroupInput) => Promise<void>
  updateGroup: (id: string, input: UpdateGroupInput) => Promise<void>
  deleteGroup: (id: string) => Promise<void>

  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  detectChrome: () => Promise<string>
  applyProfilePatch: (patch: ProfileStatusPatch) => void
}

const defaultFilters: ProfileFilters = {
  search: '',
  groupId: 'all',
  status: 'all',
  sortBy: 'name',
  sortDir: 'asc'
}

let statsRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleStatsRefresh(get: () => AppState): void {
  if (statsRefreshTimer) return
  statsRefreshTimer = setTimeout(() => {
    statsRefreshTimer = null
    void get().refreshStats()
  }, 500)
}

export const useAppStore = create<AppState>((set, get) => ({
  profiles: [],
  groups: [],
  stats: null,
  settings: null,
  selectedIds: new Set(),
  filters: defaultFilters,
  loading: false,
  error: null,

  setFilters: (patch) => {
    set((state) => ({ filters: { ...state.filters, ...patch } }))
    void get().refreshProfiles()
  },

  toggleSelect: (id) => {
    const next = new Set(get().selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    set({ selectedIds: next })
  },

  selectAll: (ids) => set({ selectedIds: new Set(ids) }),
  clearSelection: () => set({ selectedIds: new Set() }),
  clearError: () => set({ error: null }),

  refreshProfiles: async () => {
    const profiles = await window.api.profiles.list(get().filters)
    set({ profiles })
  },

  refreshGroups: async () => {
    const groups = await window.api.groups.list()
    set({ groups })
  },

  refreshStats: async () => {
    const stats = await window.api.dashboard.stats()
    set({ stats })
  },

  refreshSettings: async () => {
    const settings = await window.api.settings.get()
    set({ settings })
  },

  refreshAll: async () => {
    set({ loading: true, error: null })
    try {
      await Promise.all([
        get().refreshProfiles(),
        get().refreshGroups(),
        get().refreshStats(),
        get().refreshSettings()
      ])
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Không thể tải dữ liệu' })
    } finally {
      set({ loading: false })
    }
  },

  createProfile: async (input) => {
    const profile = await window.api.profiles.create(input)
    await get().refreshAll()
    return profile
  },

  createProfiles: async (input) => {
    const profiles = await window.api.profiles.bulkCreate(input)
    await get().refreshAll()
    return profiles
  },

  updateProfile: async (id, input) => {
    await window.api.profiles.update(id, input)
    await get().refreshAll()
  },

  deleteProfiles: async (ids) => {
    if (ids.length === 1) await window.api.profiles.remove(ids[0])
    else await window.api.profiles.bulkDelete(ids)
    get().clearSelection()
    await get().refreshAll()
  },

  resetProfile: async (id) => {
    await window.api.profiles.reset(id)
    await get().refreshAll()
  },

  duplicateProfile: async (id) => {
    await window.api.profiles.duplicate(id)
    await get().refreshAll()
  },

  launchProfiles: async (ids) => {
    const result =
      ids.length === 1
        ? await window.api.profiles.launch(ids[0]).then((r) => ({
            successIds: r.success ? [r.profileId] : [],
            failed: r.success ? [] : [{ id: r.profileId, error: r.error ?? 'Lỗi' }]
          }))
        : await window.api.profiles.bulkLaunch(ids)
    await Promise.all([get().refreshProfiles(), get().refreshStats()])
    return result
  },

  stopProfiles: async (ids) => {
    const result =
      ids.length === 1
        ? await window.api.profiles.stop(ids[0]).then((r) => ({
            successIds: r.success ? [r.profileId] : [],
            failed: r.success ? [] : [{ id: r.profileId, error: r.error ?? 'Lỗi' }]
          }))
        : await window.api.profiles.bulkStop(ids)
    await Promise.all([get().refreshProfiles(), get().refreshStats()])
    return result
  },

  bulkUpdateProfiles: async (ids, input) => {
    await window.api.profiles.bulkUpdate(ids, input)
    get().clearSelection()
    await get().refreshAll()
  },

  loginGmail: async (ids, options) => {
    const result =
      ids.length === 1
        ? await window.api.profiles.loginGmail(ids[0], options)
        : await window.api.profiles.loginGmailBulk(ids)
    await Promise.all([get().refreshProfiles(), get().refreshStats()])
    return result
  },

  createGroup: async (input) => {
    await window.api.groups.create(input)
    await get().refreshAll()
  },

  updateGroup: async (id, input) => {
    await window.api.groups.update(id, input)
    await get().refreshAll()
  },

  deleteGroup: async (id) => {
    await window.api.groups.remove(id)
    await get().refreshAll()
  },

  updateSettings: async (patch) => {
    const settings = await window.api.settings.update(patch)
    set({ settings })
  },

  detectChrome: async () => {
    const path = await window.api.settings.detectChrome()
    await get().refreshSettings()
    return path
  },

  applyProfilePatch: (patch) => {
    set((state) => ({
      profiles: state.profiles.map((p) =>
        p.id === patch.id
          ? {
              ...p,
              status: patch.status,
              lastLaunchedAt: patch.lastLaunchedAt,
              updatedAt: patch.updatedAt
            }
          : p
      )
    }))
    scheduleStatsRefresh(get)
  }
}))
