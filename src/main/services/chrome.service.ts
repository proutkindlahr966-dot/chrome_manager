import { ChildProcess, spawn } from 'child_process'
import { createServer } from 'net'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { BrowserWindow, screen } from 'electron'
import { getDb } from '../db/database'
import { IPC } from '../../shared/ipc'
import { LaunchResult, BulkResult, LaunchOptions, WindowBounds } from '../../shared/types'
import { createAsyncLock, createKeyedAsyncLock } from '../utils/async-lock'
import { toStatusPatch } from '../utils/profile-sanitize'
import {
  resolveChromeProxyServer,
  stopAllProxyRelays,
  stopProxyRelay
} from './proxy-relay.service'

interface RunningProcess {
  pid: number
  process: ChildProcess
  debugPort: number
}

const running = new Map<string, RunningProcess>()
/** Port đã gán cho Chrome chưa exit — tránh 2 launch tranh cùng port */
const reservedPorts = new Set<number>()
const withPortAlloc = createAsyncLock()
const withProfileLaunch = createKeyedAsyncLock()

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

export function detectChromePath(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return ''
}

function resolveChromePath(): string {
  const settings = getDb().getSettings()
  if (settings.chromePath && existsSync(settings.chromePath)) {
    return settings.chromePath
  }
  const detected = detectChromePath()
  if (detected) {
    getDb().updateSettings({ chromePath: detected })
    return detected
  }
  throw new Error('Không tìm thấy Chrome. Hãy cấu hình đường dẫn trong Cài đặt.')
}

const SESSION_FILE_NAMES = ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']
/** Trang New Tab chuẩn của Chrome (không dùng about:blank) */
const NEW_TAB_URL = 'chrome://newtab/'

function isNewTabUrl(url: string): boolean {
  const u = url.toLowerCase()
  return (
    u === '' ||
    u === 'about:blank' ||
    u.startsWith('chrome://newtab') ||
    u.startsWith('chrome://new-tab-page')
  )
}

/** Xóa file session Chrome để không tự mở lại tab Gmail/inbox cũ */
function clearChromeSessionFiles(dataDir: string): void {
  const defaultDir = join(dataDir, 'Default')
  if (!existsSync(defaultDir)) return

  for (const name of SESSION_FILE_NAMES) {
    const filePath = join(defaultDir, name)
    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch {
      // ignore
    }
  }

  // Sessions/ và Session Storage/
  for (const folder of ['Sessions', 'Session Storage']) {
    const dir = join(defaultDir, folder)
    if (!existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir)) {
        try {
          unlinkSync(join(dir, entry))
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Ép Preferences trước khi mở Chrome:
 * - restoreLastSession=true  → Continue where you left off
 * - restoreLastSession=false → New Tab (chrome://newtab/), xóa session cũ
 */
function prepareChromeSessionPrefs(dataDir: string, restoreLastSession: boolean): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    const defaultDir = join(dataDir, 'Default')
    mkdirSync(defaultDir, { recursive: true })
    const prefsPath = join(defaultDir, 'Preferences')

    let prefs: Record<string, unknown> = {}
    if (existsSync(prefsPath)) {
      try {
        prefs = JSON.parse(readFileSync(prefsPath, 'utf-8')) as Record<string, unknown>
      } catch {
        prefs = {}
      }
    }

    if (!restoreLastSession) {
      clearChromeSessionFiles(dataDir)
    }

    const session = {
      ...((prefs.session as Record<string, unknown> | undefined) ?? {}),
      // 5 = Open the New Tab page
      restore_on_startup: restoreLastSession ? 1 : 5,
      startup_urls: []
    }

    const profile = {
      ...((prefs.profile as Record<string, unknown> | undefined) ?? {}),
      exit_type: 'Normal',
      exited_cleanly: true
    }

    prefs.session = session
    prefs.profile = profile
    prefs.homepage = NEW_TAB_URL
    prefs.homepage_is_newtabpage = true
    prefs.browser = {
      ...((prefs.browser as Record<string, unknown> | undefined) ?? {}),
      has_seen_welcome_page: true
    }

    writeFileSync(prefsPath, JSON.stringify(prefs), 'utf-8')
  } catch {
    // Không chặn launch nếu không ghi được Preferences
  }
}

/**
 * Sau khi Chrome mở:
 * - Tab cũ bật → giữ nguyên toàn bộ tab đã restore
 * - Tab cũ tắt → chỉ 1 tab (homepage hoặc New Tab)
 */
async function enforceStartupTabs(
  debugPort: number,
  restoreLastSession: boolean,
  startUrl = NEW_TAB_URL
): Promise<void> {
  if (restoreLastSession) return

  try {
    const puppeteer = (await import('puppeteer-core')).default
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${debugPort}`,
      defaultViewport: null
    })

    try {
      const pages = await browser.pages()
      const main = pages[0] ?? (await browser.newPage())
      for (let i = 1; i < pages.length; i++) {
        await pages[i].close().catch(() => undefined)
      }
      const current = main.url()
      const wantNewTab = isNewTabUrl(startUrl)
      if (wantNewTab) {
        if (!isNewTabUrl(current)) {
          await main.goto(NEW_TAB_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(
            () => undefined
          )
        }
      } else if (current !== startUrl) {
        await main.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(
          () => undefined
        )
      }
    } finally {
      browser.disconnect()
    }
  } catch {
    // Không chặn launch nếu CDP thất bại
  }
}

function resolveStartupUrl(homepage: string | undefined): string {
  const raw = (homepage ?? '').trim()
  if (!raw || isNewTabUrl(raw)) return NEW_TAB_URL
  return raw
}

function emitStatus(profileId: string): void {
  const profile = getDb().getProfile(profileId)
  if (!profile) return
  const patch = toStatusPatch(profile)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.PROFILE_STATUS_CHANGED, patch)
  }
}

function getFreePort(): Promise<number> {
  return withPortAlloc(async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer()
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          if (!address || typeof address === 'string') {
            server.close()
            reject(new Error('Không lấy được cổng trống'))
            return
          }
          const { port: p } = address
          server.close((err) => {
            if (err) reject(err)
            else resolve(p)
          })
        })
        server.on('error', reject)
      })
      if (reservedPorts.has(port)) continue
      // Port đang được Chrome khác dùng
      if ([...running.values()].some((e) => e.debugPort === port)) continue
      reservedPorts.add(port)
      return port
    }
    throw new Error('Không lấy được cổng remote debugging trống sau nhiều lần thử')
  })
}

function releasePort(port: number): void {
  reservedPorts.delete(port)
}

async function waitForDebugger(port: number, timeoutMs = 20000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Chrome không mở cổng remote debugging kịp thời')
}

export function isRunning(profileId: string): boolean {
  return running.has(profileId)
}

export function getDebugPort(profileId: string): number | undefined {
  return running.get(profileId)?.debugPort
}

/** Chia màn hình dạng lưới chuẩn cho N cửa sổ */
export function computeTileLayout(count: number): WindowBounds[] {
  const n = Math.max(0, Math.floor(count))
  if (n <= 0) return []

  const display = screen.getPrimaryDisplay()
  const area = display.workArea
  const gap = 4

  // Ưu tiên lưới gần vuông, tối ưu cho nhiều luồng
  let cols = Math.ceil(Math.sqrt(n))
  let rows = Math.ceil(n / cols)

  // Với 2 cửa sổ: chia đôi ngang; 3: 2 cột...
  if (n === 2) {
    cols = 2
    rows = 1
  } else if (n === 3) {
    cols = 3
    rows = 1
  } else if (n === 4) {
    cols = 2
    rows = 2
  }

  const cellW = Math.floor((area.width - gap * (cols + 1)) / cols)
  const cellH = Math.floor((area.height - gap * (rows + 1)) / rows)

  const tiles: WindowBounds[] = []
  for (let i = 0; i < n; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    tiles.push({
      left: area.x + gap + col * (cellW + gap),
      top: area.y + gap + row * (cellH + gap),
      width: Math.max(400, cellW),
      height: Math.max(300, cellH)
    })
  }
  return tiles
}

/** Đặt vị trí cửa sổ Chrome qua CDP */
export async function applyWindowBounds(
  profileId: string,
  bounds: WindowBounds
): Promise<boolean> {
  const port = getDebugPort(profileId)
  if (!port) return false
  try {
    const puppeteer = (await import('puppeteer-core')).default
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null
    })
    try {
      const pages = await browser.pages()
      const page = pages[0] || (await browser.newPage())
      const session = await page.createCDPSession()
      const { windowId } = (await session.send('Browser.getWindowForTarget')) as {
        windowId: number
      }
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: Math.round(bounds.left),
          top: Math.round(bounds.top),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
          windowState: 'normal'
        }
      })
      await session.detach().catch(() => undefined)
      return true
    } finally {
      browser.disconnect()
    }
  } catch {
    return false
  }
}

export async function arrangeProfileWindows(profileIds: string[]): Promise<void> {
  const ids = profileIds.filter((id) => running.has(id))
  if (!ids.length) return
  const tiles = computeTileLayout(ids.length)
  await Promise.all(
    ids.map(async (id, index) => {
      const bounds = tiles[index]
      if (bounds) await applyWindowBounds(id, bounds)
    })
  )
}

export async function launchProfile(
  profileId: string,
  options?: LaunchOptions
): Promise<LaunchResult> {
  return withProfileLaunch(profileId, () => launchProfileUnlocked(profileId, options))
}

async function launchProfileUnlocked(
  profileId: string,
  options?: LaunchOptions
): Promise<LaunchResult> {
  const db = getDb()
  const profile = db.getProfile(profileId)
  if (!profile) {
    return { profileId, success: false, error: 'Không tìm thấy hồ sơ' }
  }

  if (running.has(profileId)) {
    const entry = running.get(profileId)!
    if (options?.windowBounds) {
      void applyWindowBounds(profileId, options.windowBounds)
    }
    return { profileId, success: true, pid: entry.pid, debugPort: entry.debugPort }
  }

  let debugPort: number | undefined
  try {
    db.setProfileStatus(profileId, 'starting')
    emitStatus(profileId)

    const chromePath = resolveChromePath()
    debugPort = await getFreePort()
    // Tab cũ theo nhóm (mặc định bật; hồ sơ chưa nhóm cũng mặc định bật)
    const group = profile.groupId ? db.getGroup(profile.groupId) : undefined
    const groupRestore = group ? group.restoreLastSession : true
    // skipHomepage (luồng Login Gmail) luôn mở sạch, không restore
    const restoreLastSession = groupRestore && !options?.skipHomepage

    prepareChromeSessionPrefs(profile.dataDir, restoreLastSession)

    // CDP chỉ listen localhost (mặc định Chrome). remote-allow-origins cần cho Puppeteer ≥ Chrome 111.
    const args = [
      `--user-data-dir=${profile.dataDir}`,
      `--remote-debugging-port=${debugPort}`,
      `--remote-allow-origins=*`,
      `--no-first-run`,
      `--no-default-browser-check`,
      `--disable-sync`,
      `--user-agent=${profile.userAgent}`
    ]

    if (options?.windowBounds) {
      const b = options.windowBounds
      args.push(`--window-position=${Math.round(b.left)},${Math.round(b.top)}`)
      args.push(`--window-size=${Math.round(b.width)},${Math.round(b.height)}`)
    }

    const proxy = await resolveChromeProxyServer(profileId, profile.proxy)
    if (proxy) args.push(`--proxy-server=${proxy}`)

    const startupUrl = resolveStartupUrl(profile.homepage)

    // Không tự điều hướng Gmail khi mở profile — restore tab cũ, homepage, hoặc New Tab
    if (restoreLastSession) {
      args.push('--restore-last-session')
    } else {
      args.push(startupUrl)
    }

    const child = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore'
    })

    if (!child.pid) {
      throw new Error('Không thể khởi chạy tiến trình Chrome')
    }

    running.set(profileId, { pid: child.pid, process: child, debugPort })
    await waitForDebugger(debugPort)

    // Luồng Login Gmail tự điều hướng — không ép New Tab
    if (!options?.skipHomepage) {
      await enforceStartupTabs(debugPort, restoreLastSession, startupUrl)
    }

    if (options?.windowBounds) {
      await applyWindowBounds(profileId, options.windowBounds)
    }

    const launched = db.setProfileStatus(profileId, 'running', new Date().toISOString())
    emitStatus(launched.id)

    child.on('exit', () => {
      running.delete(profileId)
      releasePort(debugPort!)
      void stopProxyRelay(profileId)
      try {
        db.setProfileStatus(profileId, 'idle')
        emitStatus(profileId)
      } catch {
        // profile may have been deleted
      }
    })

    child.unref()

    return { profileId, success: true, pid: child.pid, debugPort }
  } catch (error) {
    running.delete(profileId)
    if (debugPort !== undefined) releasePort(debugPort)
    void stopProxyRelay(profileId)
    db.setProfileStatus(profileId, 'error')
    emitStatus(profileId)
    return {
      profileId,
      success: false,
      error: error instanceof Error ? error.message : 'Lỗi không xác định'
    }
  }
}

/** Đóng Chrome qua CDP để cookie/session được ghi xuống disk (tránh taskkill /F mất login) */
async function gracefulCloseChrome(debugPort: number): Promise<boolean> {
  try {
    const puppeteer = (await import('puppeteer-core')).default
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${debugPort}`,
      defaultViewport: null
    })
    await browser.close()
    return true
  } catch {
    return false
  }
}

function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      try {
        process.kill(pid, 0)
        if (Date.now() - started >= timeoutMs) {
          resolve(false)
          return
        }
        setTimeout(tick, 200)
      } catch {
        resolve(true)
      }
    }
    tick()
  })
}

export async function stopProfile(profileId: string): Promise<LaunchResult> {
  return withProfileLaunch(profileId, () => stopProfileUnlocked(profileId))
}

async function stopProfileUnlocked(profileId: string): Promise<LaunchResult> {
  const db = getDb()
  const entry = running.get(profileId)
  if (!entry) {
    db.setProfileStatus(profileId, 'idle')
    emitStatus(profileId)
    return { profileId, success: true }
  }

  try {
    db.setProfileStatus(profileId, 'stopping')
    emitStatus(profileId)

    const closed = await gracefulCloseChrome(entry.debugPort)
    const exited = closed ? await waitForPidExit(entry.pid, 8000) : false

    if (!exited) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(entry.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        entry.process.kill('SIGTERM')
      }
      await waitForPidExit(entry.pid, 3000)
    }

    running.delete(profileId)
    releasePort(entry.debugPort)
    await stopProxyRelay(profileId)
    db.setProfileStatus(profileId, 'idle')
    emitStatus(profileId)
    return { profileId, success: true, pid: entry.pid }
  } catch (error) {
    running.delete(profileId)
    releasePort(entry.debugPort)
    await stopProxyRelay(profileId)
    db.setProfileStatus(profileId, 'error')
    emitStatus(profileId)
    return {
      profileId,
      success: false,
      error: error instanceof Error ? error.message : 'Không thể đóng hồ sơ'
    }
  }
}

export async function bulkLaunch(ids: string[]): Promise<BulkResult> {
  const settings = getDb().getSettings()
  const successIds: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  const tiles = computeTileLayout(ids.length)
  const queue = ids.map((id, index) => ({ id, index }))
  const workers = Math.max(1, settings.maxConcurrentLaunches)

  async function worker(): Promise<void> {
    while (queue.length) {
      const item = queue.shift()
      if (!item) break
      const result = await launchProfile(item.id, { windowBounds: tiles[item.index] })
      if (result.success) successIds.push(item.id)
      else failed.push({ id: item.id, error: result.error ?? 'Lỗi' })
    }
  }

  await Promise.all(Array.from({ length: Math.min(workers, ids.length) }, () => worker()))
  if (successIds.length > 1) {
    await arrangeProfileWindows(successIds)
  }
  return { successIds, failed }
}

export async function bulkStop(ids: string[]): Promise<BulkResult> {
  const successIds: string[] = []
  const failed: Array<{ id: string; error: string }> = []

  for (const id of ids) {
    const result = await stopProfile(id)
    if (result.success) successIds.push(id)
    else failed.push({ id, error: result.error ?? 'Lỗi' })
  }

  return { successIds, failed }
}

export async function stopAllRunning(): Promise<void> {
  const ids = [...running.keys()]
  await bulkStop(ids)
  await stopAllProxyRelays()
}
