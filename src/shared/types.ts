export type ProfileStatus = 'idle' | 'running' | 'starting' | 'stopping' | 'error'

export type ProxyType = 'none' | 'http' | 'https' | 'socks5'

export interface ProxyConfig {
  type: ProxyType
  host: string
  port: number | null
  username: string
  password: string
}

export interface GmailCredentials {
  email: string
  password: string
  recoveryEmail: string
  /** Mã 2FA 6 số (cột 3) hoặc secret TOTP Base32 */
  totpSecret: string
  /** Chuỗi gốc mail|pass|2fa hoặc mail|pass|recovery|2fa */
  raw?: string
}

export interface ChromeProfile {
  id: string
  name: string
  notes: string
  groupId: string | null
  userAgent: string
  proxy: ProxyConfig
  dataDir: string
  homepage: string
  tags: string[]
  gmail: GmailCredentials | null
  autoLoginGmail: boolean
  status: ProfileStatus
  lastLaunchedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ProfileGroup {
  id: string
  name: string
  color: string
  description: string
  /** Mở lại tab lần chạy trước cho mọi hồ sơ trong nhóm (mặc định bật) */
  restoreLastSession: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateProfileInput {
  name: string
  notes?: string
  groupId?: string | null
  userAgent?: string
  proxy?: Partial<ProxyConfig>
  homepage?: string
  tags?: string[]
  gmail?: Partial<GmailCredentials> | null
  autoLoginGmail?: boolean
}

export interface BulkCreateProfileInput extends CreateProfileInput {
  /** Số lượng hồ sơ cần tạo (1–500) */
  count: number
  /** Số bắt đầu khi đánh số tên, mặc định 1 */
  startIndex?: number
  /**
   * Danh sách proxy — mỗi phần tử gắn 1 hồ sơ theo thứ tự tạo.
   * Hồ sơ vượt quá số dòng → không dùng proxy (none).
   */
  proxyList?: ProxyConfig[]
}

export interface UpdateProfileInput {
  name?: string
  notes?: string
  groupId?: string | null
  userAgent?: string
  proxy?: Partial<ProxyConfig>
  homepage?: string
  tags?: string[]
  gmail?: Partial<GmailCredentials> | null
  autoLoginGmail?: boolean
}

export interface CreateGroupInput {
  name: string
  color?: string
  description?: string
  restoreLastSession?: boolean
}

export interface UpdateGroupInput {
  name?: string
  color?: string
  description?: string
  restoreLastSession?: boolean
}

export interface ProfileFilters {
  search?: string
  groupId?: string | null
  status?: ProfileStatus | 'all'
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'lastLaunchedAt'
  sortDir?: 'asc' | 'desc'
}

export interface DashboardStats {
  totalProfiles: number
  runningProfiles: number
  idleProfiles: number
  totalGroups: number
  withGmail: number
  withoutGmail: number
  withProxy: number
  errorProfiles: number
  startingOrStopping: number
  recentlyLaunched: ChromeProfile[]
  groupBreakdown: Array<{
    groupId: string | null
    groupName: string
    count: number
    withGmail: number
  }>
}

export interface AppSettings {
  chromePath: string
  profilesRoot: string
  theme: 'light' | 'dark' | 'system'
  defaultUserAgent: string
  closeOnExit: boolean
  maxConcurrentLaunches: number
}

export interface WindowBounds {
  left: number
  top: number
  width: number
  height: number
}

export interface LaunchOptions {
  skipHomepage?: boolean
  skipAutoLogin?: boolean
  windowBounds?: WindowBounds
}

export interface GmailLoginOptions {
  alreadyLaunched?: boolean
  windowBounds?: WindowBounds
  /** Credentials dùng để login (ưu tiên hơn gmail đang lưu trên hồ sơ) */
  credentials?: GmailCredentials | null
  autoLoginGmail?: boolean
  /**
   * Mail cũ / mail mới: sau Next email, gặp Confirm you’re not a robot → bấm checkbox rồi nhập pass.
   * Khác nhau ở cách ghép list ↔ profile (mail mới cố định 1–1; mail cũ thay mail khi lỗi).
   */
  mailKind?: 'old' | 'new'
  /** true: nếu đã có session Gmail thì giữ, không clear cookie */
  preferExistingSession?: boolean
  /** Sau login OK: đổi avatar + mở Sheet + Apps Script */
  postLoginSetup?: boolean
  /** Đường dẫn ảnh đại diện tuyệt đối (dùng chung) */
  avatarPath?: string
  /** Đường dẫn file .txt chứa code Apps Script (ưu tiên) */
  appsScriptPath?: string
  /** Code inline (fallback cũ; ưu tiên đọc từ appsScriptPath) */
  appsScriptCode?: string
  /** Secret TOTP để xác minh lại khi đổi ảnh / thao tác nhạy cảm */
  totpSecret?: string
  /** Sau mở Form: điền tiêu đề / mô tả nếu bật */
  formFillEnabled?: boolean
  formTitle?: string
  formDescription?: string
  /** Ảnh header Google Form (upload qua Customize theme) */
  formHeaderPath?: string
}

export interface GmailPostSetupConfig {
  enabled: boolean
  avatarPath: string
  /** Đường dẫn file .txt / .gs chứa code Apps Script */
  appsScriptPath: string
  /** Fallback nội dung inline (cấu hình cũ) */
  appsScriptCode: string
  /** Bật điền tiêu đề / mô tả vào tab Google Form */
  formFillEnabled: boolean
  /** Tiêu đề form (thay "Untitled form") */
  formTitle: string
  /** Mô tả form (Form description) */
  formDescription: string
  /** Ảnh header Form (Customize theme → Header → Upload) */
  formHeaderPath: string
}

export const DEFAULT_GMAIL_POST_SETUP: GmailPostSetupConfig = {
  enabled: true,
  avatarPath: '',
  appsScriptPath: '',
  appsScriptCode: '',
  formFillEnabled: false,
  formTitle: '',
  formDescription: '',
  formHeaderPath: ''
}

/** Xem trước ảnh trong renderer — dataUrl rỗng khi file quá lớn */
export interface ImagePreview {
  exists: boolean
  dataUrl: string
  size: number
  name: string
}

/** Patch trạng thái realtime — không kèm credentials. */
export interface ProfileStatusPatch {
  id: string
  status: ProfileStatus
  lastLaunchedAt: string | null
  updatedAt: string
}

export interface LaunchResult {
  profileId: string
  success: boolean
  pid?: number
  debugPort?: number
  error?: string
}

export interface GmailLoginResult {
  profileId: string
  success: boolean
  message?: string
  error?: string
}

/** Tiến trình từng bước login Gmail — dùng khi chạy nhiều luồng song song */
export interface GmailLoginProgress {
  profileId: string
  profileName: string
  email: string
  step: string
  tone: 'info' | 'success' | 'warn' | 'error'
  at: string
}

export interface BulkResult {
  successIds: string[]
  failed: Array<{ id: string; error: string }>
}

export const DEFAULT_PROXY: ProxyConfig = {
  type: 'none',
  host: '',
  port: null,
  username: '',
  password: ''
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const GROUP_COLORS = [
  '#0F766E',
  '#0369A1',
  '#7C3AED',
  '#BE185D',
  '#C2410C',
  '#4D7C0F',
  '#A16207',
  '#475569'
] as const
