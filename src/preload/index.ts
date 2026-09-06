import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AppSettings,
  BulkResult,
  ChromeProfile,
  CreateGroupInput,
  CreateProfileInput,
  BulkCreateProfileInput,
  DashboardStats,
  GmailLoginResult,
  GmailLoginOptions,
  GmailPostSetupConfig,
  ImagePreview,
  LaunchResult,
  ProfileFilters,
  ProfileGroup,
  ProfileStatusPatch,
  UpdateGroupInput,
  UpdateProfileInput,
  WindowBounds
} from '../shared/types'

const api = {
  profiles: {
    list: (filters?: ProfileFilters): Promise<ChromeProfile[]> =>
      ipcRenderer.invoke(IPC.PROFILES_LIST, filters),
    get: (id: string): Promise<ChromeProfile | null> => ipcRenderer.invoke(IPC.PROFILES_GET, id),
    create: (input: CreateProfileInput): Promise<ChromeProfile> =>
      ipcRenderer.invoke(IPC.PROFILES_CREATE, input),
    bulkCreate: (input: BulkCreateProfileInput): Promise<ChromeProfile[]> =>
      ipcRenderer.invoke(IPC.PROFILES_BULK_CREATE, input),
    update: (id: string, input: UpdateProfileInput): Promise<ChromeProfile> =>
      ipcRenderer.invoke(IPC.PROFILES_UPDATE, id, input),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.PROFILES_DELETE, id),
    duplicate: (id: string): Promise<ChromeProfile> =>
      ipcRenderer.invoke(IPC.PROFILES_DUPLICATE, id),
    bulkDelete: (ids: string[]): Promise<BulkResult> =>
      ipcRenderer.invoke(IPC.PROFILES_BULK_DELETE, ids),
    bulkUpdate: (ids: string[], input: UpdateProfileInput): Promise<BulkResult> =>
      ipcRenderer.invoke(IPC.PROFILES_BULK_UPDATE, ids, input),
    launch: (id: string): Promise<LaunchResult> => ipcRenderer.invoke(IPC.PROFILES_LAUNCH, id),
    stop: (id: string): Promise<LaunchResult> => ipcRenderer.invoke(IPC.PROFILES_STOP, id),
    bulkLaunch: (ids: string[]): Promise<BulkResult> =>
      ipcRenderer.invoke(IPC.PROFILES_BULK_LAUNCH, ids),
    bulkStop: (ids: string[]): Promise<BulkResult> =>
      ipcRenderer.invoke(IPC.PROFILES_BULK_STOP, ids),
    loginGmail: (id: string, options?: GmailLoginOptions): Promise<GmailLoginResult> =>
      ipcRenderer.invoke(IPC.PROFILES_LOGIN_GMAIL, id, options),
    loginGmailBulk: (ids: string[]): Promise<BulkResult> =>
      ipcRenderer.invoke(IPC.PROFILES_LOGIN_GMAIL_BULK, ids),
    tileLayout: (count: number): Promise<WindowBounds[]> =>
      ipcRenderer.invoke(IPC.PROFILES_TILE_LAYOUT, count),
    arrangeWindows: (ids: string[]): Promise<boolean> =>
      ipcRenderer.invoke(IPC.PROFILES_ARRANGE_WINDOWS, ids),
    loadGmailList: (): Promise<{ content: string; path: string }> =>
      ipcRenderer.invoke(IPC.GMAIL_LIST_LOAD),
    saveGmailList: (content: string): Promise<{ path: string; count: number }> =>
      ipcRenderer.invoke(IPC.GMAIL_LIST_SAVE, content),
    loadFailedGmailEmails: (): Promise<string[]> => ipcRenderer.invoke(IPC.GMAIL_FAILED_LOAD),
    saveFailedGmailEmails: (emails: string[]): Promise<{ path: string; count: number }> =>
      ipcRenderer.invoke(IPC.GMAIL_FAILED_SAVE, emails),
    loadGmailSetup: (): Promise<GmailPostSetupConfig> => ipcRenderer.invoke(IPC.GMAIL_SETUP_LOAD),
    saveGmailSetup: (
      config: GmailPostSetupConfig
    ): Promise<{ path: string; config: GmailPostSetupConfig }> =>
      ipcRenderer.invoke(IPC.GMAIL_SETUP_SAVE, config),
    pickImageFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.DIALOG_OPEN_IMAGE),
    readImagePreview: (path: string): Promise<ImagePreview> =>
      ipcRenderer.invoke(IPC.FILE_IMAGE_PREVIEW, path),
    pickScriptTextFile: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC.DIALOG_OPEN_SCRIPT_TEXT),
    onStatusChanged: (cb: (patch: ProfileStatusPatch) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, patch: ProfileStatusPatch): void =>
        cb(patch)
      ipcRenderer.on(IPC.PROFILE_STATUS_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.PROFILE_STATUS_CHANGED, listener)
    }
  },
  groups: {
    list: (): Promise<ProfileGroup[]> => ipcRenderer.invoke(IPC.GROUPS_LIST),
    create: (input: CreateGroupInput): Promise<ProfileGroup> =>
      ipcRenderer.invoke(IPC.GROUPS_CREATE, input),
    update: (id: string, input: UpdateGroupInput): Promise<ProfileGroup> =>
      ipcRenderer.invoke(IPC.GROUPS_UPDATE, id, input),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.GROUPS_DELETE, id)
  },
  dashboard: {
    stats: (): Promise<DashboardStats> => ipcRenderer.invoke(IPC.DASHBOARD_STATS)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.SETTINGS_UPDATE, patch),
    detectChrome: (): Promise<string> => ipcRenderer.invoke(IPC.SETTINGS_DETECT_CHROME)
  }
}

if (process.contextIsolated) {
  try {
    // Chỉ expose typed API — không expose ipcRenderer generic / process.env
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  Object.assign(window, { api })
}

export type AppApi = typeof api
