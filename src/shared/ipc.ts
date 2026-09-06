export const IPC = {
  // Profiles
  PROFILES_LIST: 'profiles:list',
  PROFILES_GET: 'profiles:get',
  PROFILES_CREATE: 'profiles:create',
  PROFILES_BULK_CREATE: 'profiles:bulkCreate',
  PROFILES_UPDATE: 'profiles:update',
  PROFILES_DELETE: 'profiles:delete',
  PROFILES_DUPLICATE: 'profiles:duplicate',
  PROFILES_BULK_DELETE: 'profiles:bulkDelete',
  PROFILES_BULK_UPDATE: 'profiles:bulkUpdate',

  // Launch
  PROFILES_LAUNCH: 'profiles:launch',
  PROFILES_STOP: 'profiles:stop',
  PROFILES_BULK_LAUNCH: 'profiles:bulkLaunch',
  PROFILES_BULK_STOP: 'profiles:bulkStop',
  PROFILES_LOGIN_GMAIL: 'profiles:loginGmail',
  PROFILES_LOGIN_GMAIL_BULK: 'profiles:loginGmailBulk',
  PROFILES_TILE_LAYOUT: 'profiles:tileLayout',
  PROFILES_ARRANGE_WINDOWS: 'profiles:arrangeWindows',
  PROFILE_STATUS_CHANGED: 'profiles:statusChanged',

  // Gmail list file
  GMAIL_LIST_LOAD: 'gmailList:load',
  GMAIL_LIST_SAVE: 'gmailList:save',
  GMAIL_FAILED_LOAD: 'gmailList:failedLoad',
  GMAIL_FAILED_SAVE: 'gmailList:failedSave',
  GMAIL_SETUP_LOAD: 'gmailSetup:load',
  GMAIL_SETUP_SAVE: 'gmailSetup:save',
  DIALOG_OPEN_IMAGE: 'dialog:openImage',
  DIALOG_OPEN_SCRIPT_TEXT: 'dialog:openScriptText',
  FILE_IMAGE_PREVIEW: 'file:imagePreview',

  // Groups
  GROUPS_LIST: 'groups:list',
  GROUPS_CREATE: 'groups:create',
  GROUPS_UPDATE: 'groups:update',
  GROUPS_DELETE: 'groups:delete',

  // Dashboard & settings
  DASHBOARD_STATS: 'dashboard:stats',
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_DETECT_CHROME: 'settings:detectChrome'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
