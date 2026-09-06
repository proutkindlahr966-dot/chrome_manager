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
} from '@shared/types'

export interface AppApi {
  profiles: {
    list: (filters?: ProfileFilters) => Promise<ChromeProfile[]>
    get: (id: string) => Promise<ChromeProfile | null>
    create: (input: CreateProfileInput) => Promise<ChromeProfile>
    bulkCreate: (input: BulkCreateProfileInput) => Promise<ChromeProfile[]>
    update: (id: string, input: UpdateProfileInput) => Promise<ChromeProfile>
    remove: (id: string) => Promise<boolean>
    duplicate: (id: string) => Promise<ChromeProfile>
    bulkDelete: (ids: string[]) => Promise<BulkResult>
    bulkUpdate: (ids: string[], input: UpdateProfileInput) => Promise<BulkResult>
    launch: (id: string) => Promise<LaunchResult>
    stop: (id: string) => Promise<LaunchResult>
    bulkLaunch: (ids: string[]) => Promise<BulkResult>
    bulkStop: (ids: string[]) => Promise<BulkResult>
    loginGmail: (id: string, options?: GmailLoginOptions) => Promise<GmailLoginResult>
    loginGmailBulk: (ids: string[]) => Promise<BulkResult>
    tileLayout: (count: number) => Promise<WindowBounds[]>
    arrangeWindows: (ids: string[]) => Promise<boolean>
    loadGmailList: () => Promise<{ content: string; path: string }>
    saveGmailList: (content: string) => Promise<{ path: string; count: number }>
    loadFailedGmailEmails: () => Promise<string[]>
    saveFailedGmailEmails: (emails: string[]) => Promise<{ path: string; count: number }>
    loadGmailSetup: () => Promise<GmailPostSetupConfig>
    saveGmailSetup: (
      config: GmailPostSetupConfig
    ) => Promise<{ path: string; config: GmailPostSetupConfig }>
    pickImageFile: () => Promise<string | null>
    readImagePreview: (path: string) => Promise<ImagePreview>
    pickScriptTextFile: () => Promise<string | null>
    onStatusChanged: (cb: (patch: ProfileStatusPatch) => void) => () => void
  }
  groups: {
    list: () => Promise<ProfileGroup[]>
    create: (input: CreateGroupInput) => Promise<ProfileGroup>
    update: (id: string, input: UpdateGroupInput) => Promise<ProfileGroup>
    remove: (id: string) => Promise<boolean>
  }
  dashboard: {
    stats: () => Promise<DashboardStats>
  }
  settings: {
    get: () => Promise<AppSettings>
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>
    detectChrome: () => Promise<string>
  }
}

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
