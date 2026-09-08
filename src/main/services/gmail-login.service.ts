import { AsyncLocalStorage } from 'async_hooks'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import type { Browser, Frame, Page, ElementHandle, Target } from 'puppeteer-core'
import { getDb } from '../db/database'
import {
  getGmailColumn3,
  hasGmailCredentials,
  isSixDigitCode,
  normalizeGmail,
  resolveTotpSecret
} from '../../shared/gmail'
import { IPC } from '../../shared/ipc'
import type {
  BulkResult,
  GmailCredentials,
  GmailLoginOptions,
  GmailLoginProgress,
  GmailLoginResult
} from '../../shared/types'
import { applyWindowBounds, getDebugPort, launchProfile } from './chrome.service'
import { getDataRoot } from '../utils/paths'

interface LoginLogContext {
  profileId: string
  profileName: string
  email: string
}

const loginLogContext = new AsyncLocalStorage<LoginLogContext>()

const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox'
const LOGIN_URL =
  'https://accounts.google.com/signin/v2/identifier?hl=en&continue=' +
  encodeURIComponent(GMAIL_URL) +
  '&flowName=GlifWebSignIn&flowEntry=ServiceLogin'

/** Chờ người dùng nhập captcha chữ (Type the text...) trên cửa sổ Chrome */
const MANUAL_CAPTCHA_TIMEOUT_MS = 3 * 60 * 1000

const EMAIL_SELECTORS = ['#identifierId', 'input[name="identifier"]', 'input[type="email"]']
const PASSWORD_SELECTORS = [
  'input[name="Passwd"]',
  'input[name="password"]',
  'input[type="password"]'
]
const TOTP_SELECTORS = [
  'input[name="totpPin"]',
  'input[id="totpPin"]',
  '#totpPin',
  'input[autocomplete="one-time-code"]',
  'input[aria-label="Enter code" i]',
  'input[aria-label*="Enter code" i]',
  'input[aria-label*="Enter the code" i]',
  'input[aria-label*="Nhập mã" i]',
  'input[type="tel"][maxlength="6"]',
  'input[type="text"][maxlength="6"]',
  'input[inputmode="numeric"][maxlength="6"]',
  'input[name="Pin"][maxlength="6"]',
  'input[name="Pin"][maxlength="8"]'
]

function isTotpChallengeUrl(url: string): boolean {
  const u = url.toLowerCase()
  return u.includes('challenge/totp') || u.includes('totppin') || u.includes('/totp')
}

class SkipLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkipLoginError'
  }
}

function loginDebugLog(message: string, extra?: unknown): void {
  try {
    const ctx = loginLogContext.getStore()
    const tag = ctx ? `[${ctx.profileName}|${ctx.email}] ` : ''
    const dir = getDataRoot()
    mkdirSync(dir, { recursive: true })
    const line =
      `[${new Date().toISOString()}] ${tag}${message}` +
      (extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`)
    appendFileSync(join(dir, 'gmail-login-debug.log'), line + '\n', 'utf8')
  } catch {
    // ignore
  }
}

/** Đẩy bước hiện tại lên nhật ký UI (an toàn khi nhiều luồng song song) */
function emitLoginProgress(
  step: string,
  tone: GmailLoginProgress['tone'] = 'info'
): void {
  const ctx = loginLogContext.getStore()
  if (!ctx) return
  loginDebugLog(`bước: ${step}`)
  const payload: GmailLoginProgress = {
    profileId: ctx.profileId,
    profileName: ctx.profileName,
    email: ctx.email,
    step,
    tone,
    at: new Date().toISOString()
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.GMAIL_LOGIN_PROGRESS, payload)
  }
}

async function generateTotp(secret: string): Promise<string> {
  try {
    const OTPAuth = await import('otpauth')
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(secret.replace(/\s+/g, '').toUpperCase()),
      digits: 6,
      period: 30,
      algorithm: 'SHA1'
    })
    return totp.generate()
  } catch {
    throw new Error('Mã 2FA không hợp lệ (cần 6 số ở cột 3, hoặc secret Base32).')
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Số ngẫu nhiên trong [min, max] — dùng để nhập giống người */
function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

async function humanDelay(minMs: number, maxMs: number): Promise<void> {
  await delay(rand(minMs, maxMs))
}

/**
 * Gõ từng ký tự với tốc độ biến thiên (giống tay người).
 * Tránh gõ đều 75ms — Google dễ nhận pattern bot.
 */
async function typeLikeHuman(page: Page, value: string): Promise<void> {
  for (let i = 0; i < value.length; i++) {
    await page.keyboard.type(value[i], { delay: 0 })
    // Chậm hơn ở đầu / giữa chuỗi; thỉnh thoảng nghỉ dài hơn
    if (i > 0 && i % rand(4, 7) === 0) {
      await humanDelay(220, 480)
    } else {
      await humanDelay(95, 210)
    }
  }
}

/** Di chuyển chuột rồi click vào ô (trusted pointer events) */
async function humanClickHandle(page: Page, handle: ElementHandle<Element>): Promise<void> {
  await handle.evaluate((el) => {
    ;(el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' })
  })
  await humanDelay(120, 280)
  const box = await handle.boundingBox()
  if (box && box.width >= 4 && box.height >= 4) {
    const x = box.x + box.width * (0.35 + Math.random() * 0.3)
    const y = box.y + box.height * (0.4 + Math.random() * 0.25)
    await page.mouse.move(x, y, { steps: rand(8, 16) })
    await humanDelay(60, 160)
    await page.mouse.click(x, y, { delay: rand(40, 90) })
    return
  }
  await handle.click({ delay: rand(40, 90) })
}

/** Gắn nhãn tab/cửa sổ để phân biệt khi chạy nhiều Chrome */
async function tagPageIdentity(page: Page, label: string): Promise<void> {
  await page
    .evaluate((t) => {
      try {
        document.title = t
      } catch {
        // ignore
      }
    }, label)
    .catch(() => undefined)
}

/** Xác nhận Puppeteer đang nối đúng cổng của profile (không nhầm Chrome khác) */
function assertConnectedToPort(browser: Browser, expectedPort: number): void {
  const ws = browser.wsEndpoint()
  if (!ws.includes(`:${expectedPort}`)) {
    throw new Error(
      `Kết nối CDP nhầm cổng — kỳ vọng ${expectedPort}, thực tế: ${ws}`
    )
  }
}

/** Giữ đúng 1 tab — đóng mọi tab thừa, không tạo tab mới nếu đã có */
async function ensureSinglePage(browser: Browser): Promise<Page> {
  let pages = await browser.pages()
  if (pages.length === 0) {
    return browser.newPage()
  }

  const main = pages[0]
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => undefined)
  }

  // Đóng popup vừa mở thêm trong lúc chờ
  pages = await browser.pages()
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => undefined)
  }

  await main.bringToFront().catch(() => undefined)
  return main
}

/** Chặn Google/puppeteer mở tab mới: đóng ngay và (nếu cần) điều hướng tab chính */
function attachSingleTabGuard(browser: Browser, mainPage: Page): () => void {
  const onTargetCreated = (target: Target): void => {
    void (async () => {
      try {
        if (target.type() !== 'page') return
        const created = await target.page()
        if (!created || created === mainPage) return
        const url = target.url()
        await created.close().catch(() => undefined)
        // Nếu popup mang URL login/gmail hữu ích — mở trên tab chính
        if (url && url !== 'about:blank') {
          // Tránh nhảy sang trang marketing workspace.google.com
          if (isWorkspaceMarketingUrl(url)) {
            await mainPage
              .goto(GMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
              .catch(() => undefined)
          } else if (url.includes('accounts.google.com') || url.includes('mail.google.com')) {
            await mainPage
              .goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
              .catch(() => undefined)
          }
        }
        await ensureSinglePage(browser)
      } catch {
        // ignore
      }
    })()
  }

  browser.on('targetcreated', onTargetCreated)
  return () => {
    browser.off('targetcreated', onTargetCreated)
  }
}

async function findVisible(
  page: Page,
  selectors: string[],
  timeoutMs = 8000
): Promise<ElementHandle<Element> | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const selector of selectors) {
      const handles = await page.$$(selector)
      for (const handle of handles) {
        const visible = await handle.evaluate((el) => {
          const node = el as HTMLElement
          const style = window.getComputedStyle(node)
          const rect = node.getBoundingClientRect()
          const disabled =
            node instanceof HTMLInputElement || node instanceof HTMLButtonElement
              ? node.disabled
              : false
          return (
            !disabled &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0
          )
        })
        if (visible) return handle
        await handle.dispose()
      }
    }
    await delay(200)
  }
  return null
}

async function pageText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body?.innerText?.toLowerCase() ?? '')
  } catch (error) {
    // Đang chuyển trang (sau 2FA → Sign in faster / inbox) — không coi là lỗi login
    if (isDestroyedContextError(error)) return ''
    throw error
  }
}

/** Lỗi Puppeteer khi trang đang navigate — thường gặp sau 2FA thành công */
function isDestroyedContextError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    msg.includes('execution context was destroyed') ||
    msg.includes('most likely because of a navigation') ||
    msg.includes('detached frame') ||
    msg.includes('frame was detached') ||
    msg.includes('target closed') ||
    msg.includes('session closed') ||
    msg.includes('cannot find context')
  )
}

/** Màn sau login thành công: Sign in faster (passkey), speedbump, continue… */
function isPostAuthOptionalUrl(url: string): boolean {
  const u = url.toLowerCase()
  return (
    u.includes('passkey') ||
    u.includes('passkeyenrollment') ||
    u.includes('speedbump') ||
    u.includes('signin/continue') ||
    u.includes('myaccount.google.com') ||
    u.includes('accountoptions') ||
    u.includes('/interstitials/')
  )
}

function isSignInFasterText(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('sign in faster') ||
    t.includes('đăng nhập nhanh hơn') ||
    t.includes('passkey') ||
    t.includes('khóa truy cập') ||
    t.includes('create a passkey') ||
    t.includes('tạo khóa') ||
    t.includes('use your screen lock') ||
    t.includes('skippable')
  )
}

function isRobotChallenge(text: string): boolean {
  // Captcha chữ (Type the text...) → chờ nhập tay, không bỏ qua ngay
  if (isManualTextCaptcha(text)) return false
  const t = text
    .toLowerCase()
    .replace(/['’‘`]/g, '') // chuẩn hoá dấu nháy trong "you're"
  return (
    t.includes('confirm youre not a robot') ||
    t.includes('confirm you are not a robot') ||
    t.includes('không phải là robot') ||
    t.includes('unusual traffic') ||
    (t.includes('not a robot') && t.includes('confirm'))
  )
}

/** Captcha ảnh/âm thanh: "Type the text you hear or see" */
function isManualTextCaptcha(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('type the text you hear or see') ||
    t.includes('type the text') ||
    t.includes('nhập văn bản bạn nghe hoặc thấy') ||
    t.includes('nhập chữ bạn nghe') ||
    t.includes('nhập văn bản') ||
    t.includes('hear or see')
  )
}

async function hasManualTextCaptcha(page: Page): Promise<boolean> {
  if (isManualTextCaptcha(await pageText(page))) return true
  const el = await findVisible(
    page,
    ['input[name="ca"]', 'input[id="ca"]', 'input[aria-label*="Type the text" i]'],
    600
  )
  if (!el) return false
  await el.dispose()
  return true
}

/**
 * Nếu gặp captcha chữ sau khi nhập email → tạm dừng, chờ user nhập tay trên Chrome.
 * Xong khi xuất hiện ô mật khẩu hoặc captcha biến mất.
 */
async function waitForManualCaptchaIfNeeded(
  page: Page,
  timeoutMs = MANUAL_CAPTCHA_TIMEOUT_MS
): Promise<void> {
  if (!(await hasManualTextCaptcha(page))) return

  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const pass = await findVisible(page, PASSWORD_SELECTORS, 500)
    if (pass) {
      await pass.dispose()
      return
    }
    if (!(await hasManualTextCaptcha(page))) {
      // Đã qua captcha (user bấm Next) — chờ password xuất hiện thêm một lúc
      const passSoon = await findVisible(page, PASSWORD_SELECTORS, 8000)
      if (passSoon) {
        await passSoon.dispose()
      }
      return
    }
    await delay(1000)
  }

  throw new SkipLoginError(
    'Hết thời gian chờ nhập captcha (3 phút) — bỏ qua mail này để thử mail khác.'
  )
}

/** Google báo mã TOTP sai — chỉ đọc banner lỗi, không quét cả body (tránh false positive) */
function isIncorrectTotpError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('wrong code') ||
    t.includes('incorrect code') ||
    t.includes('invalid code') ||
    t.includes("that code didn't work") ||
    t.includes('that code didn’t work') ||
    t.includes('code is incorrect') ||
    t.includes('code was incorrect') ||
    t.includes('mã không chính xác') ||
    t.includes('mã xác minh không đúng') ||
    t.includes('mã xác thực không đúng')
  )
}

/** Chỉ lấy text từ vùng báo lỗi Google (alert / aria-live / class lỗi Material) */
async function readTotpErrorText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const sels = [
        '[role="alert"]',
        '[aria-live="assertive"]',
        '[aria-live="polite"]',
        '.Ekjuhf',
        '.o6cuMc',
        '.dEOOab',
        '.LXRPh',
        '.ly3Yne',
        '[jsname="B34EJ"]',
        '[jsname="h9d3hd"]'
      ]
      const parts: string[] = []
      for (const sel of sels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const t = ((el as HTMLElement).innerText || '').trim()
          if (t) parts.push(t)
        }
      }
      return parts.join('\n').toLowerCase()
    })
  } catch (error) {
    // Navigate sau Next 2FA → Sign in faster — không phải mã sai
    if (isDestroyedContextError(error)) return ''
    throw error
  }
}

async function pageShowsTotpRejected(page: Page): Promise<boolean> {
  try {
    const banner = await readTotpErrorText(page)
    if (banner && isIncorrectTotpError(banner)) return true
    // Fallback: chỉ khi banner có chữ code + (wrong|invalid|incorrect)
    if (
      banner.includes('code') &&
      (banner.includes('wrong') || banner.includes('invalid') || banner.includes('incorrect'))
    ) {
      return true
    }
    return false
  } catch (error) {
    if (isDestroyedContextError(error)) return false
    throw error
  }
}

/** Chỉ bỏ qua khi Google BẮT buộc xác minh SĐT (không chỉ nhắc tới phone trên trang 2FA/speedbump) */
function isPhoneVerificationRequired(text: string, url: string): boolean {
  const u = url.toLowerCase()
  // Trang 2FA / authenticator — có chữ phone nhưng không phải bắt buộc SMS
  if (u.includes('totp') || u.includes('challenge/totp') || u.includes('challenge/sk')) {
    return false
  }

  // Màn chọn 2FA — có nhắc phone nhưng vẫn chọn Authenticator được
  if (
    u.includes('challenge/dp') ||
    u.includes('challenge/selection') ||
    u.includes('selectchallenge')
  ) {
    const hasAuthenticatorOption =
      text.includes('google authenticator') ||
      text.includes('authenticator app') ||
      text.includes('get a verification code') ||
      text.includes('ứng dụng xác thực')
    if (hasAuthenticatorOption) return false
  }

  // Speedbump "Add phone" thường có Not now — không coi là bắt buộc
  const optionalPhonePrompt =
    text.includes('not now') ||
    text.includes('để sau') ||
    text.includes('skip') ||
    text.includes('bỏ qua')

  const hasAuthenticatorChoice =
    text.includes('google authenticator') ||
    text.includes('authenticator app') ||
    text.includes('ứng dụng xác thực') ||
    text.includes('mã từ ứng dụng')

  if (hasAuthenticatorChoice || optionalPhonePrompt) return false

  return (
    text.includes('verify your phone number') ||
    text.includes('xác minh số điện thoại của bạn') ||
    text.includes('enter a phone number to get a text message') ||
    text.includes('nhập số điện thoại để nhận') ||
    (u.includes('challenge/ipp') &&
      (text.includes('phone') || text.includes('điện thoại')))
  )
}

function detectHardError(
  text: string,
  url = '',
  options?: { ignoreTotpError?: boolean }
): string | null {
  if (
    text.includes('your password was changed') ||
    text.includes('password was changed') ||
    text.includes('mật khẩu của bạn đã được thay đổi') ||
    text.includes('mật khẩu đã được thay đổi') ||
    text.includes('mật khẩu đã thay đổi')
  ) {
    return 'Your password was changed — mật khẩu đã bị đổi, bỏ qua.'
  }
  if (
    text.includes('wrong password') ||
    text.includes('mật khẩu không chính xác') ||
    text.includes('incorrect password')
  ) {
    return 'Mật khẩu Gmail không đúng.'
  }
  // Không bắt "mã 2FA sai" từ full page text ở đây — dễ false positive.
  // Chỉ kiểm tra banner lỗi trong submitTotpOrSkip / pageShowsTotpRejected.
  if (
    text.includes("couldn't find your google account") ||
    text.includes('couldn’t find your google account') ||
    text.includes('không tìm thấy tài khoản')
  ) {
    return 'Không tìm thấy tài khoản Gmail.'
  }
  if (text.includes('too many failed attempts') || text.includes('quá nhiều lần thử')) {
    return 'Google khóa tạm do thử quá nhiều — bỏ qua.'
  }
  if (isPhoneVerificationRequired(text, url)) {
    return 'Google bắt buộc xác minh số điện thoại — bỏ qua.'
  }
  return null
}

/** Reset login trên ĐÚNG 1 tab hiện tại — không logout URL (hay mở tab mới) */
async function resetToLoginPage(page: Page): Promise<void> {
  try {
    const client = await page.createCDPSession()
    await client.send('Network.clearBrowserCookies').catch(() => undefined)
    await client.send('Network.clearBrowserCache').catch(() => undefined)
    await client.detach().catch(() => undefined)
  } catch {
    // ignore
  }

  // Đi thẳng trang login (không qua about:blank để tránh nhảy thêm lần)
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await humanDelay(900, 1600)
}

async function assertNotRobot(
  page: Page,
  options?: { ignorePhone?: boolean; ignoreTotpError?: boolean }
): Promise<void> {
  let text = ''
  let url = ''
  try {
    text = await pageText(page)
    url = page.url()
  } catch (error) {
    // Đang navigate (Sign in faster / inbox) — bỏ qua kiểm tra lỗi cứng
    if (isDestroyedContextError(error)) return
    throw error
  }
  if (isRobotChallenge(text)) {
    // Không reset ở đây — chỉ throw; caller/catch reset đúng 1 lần
    throw new SkipLoginError(
      'Mail lỗi: Confirm you’re not a robot — ghi nhận để "Xóa mail lỗi".'
    )
  }
  const hard = detectHardError(text, url, { ignoreTotpError: options?.ignoreTotpError })
  if (!hard) return
  if (options?.ignorePhone && hard.includes('điện thoại')) return
  if (
    hard.includes('bỏ qua') ||
    hard.includes('điện thoại') ||
    hard.includes('không đúng') ||
    hard.includes('không chính xác') ||
    hard.includes('2FA') ||
    hard.includes('Không tìm thấy') ||
    hard.includes('password was changed') ||
    hard.includes('mật khẩu đã')
  ) {
    throw new SkipLoginError(hard)
  }
  throw new Error(hard)
}

async function readInputValue(el: ElementHandle<Element>): Promise<string> {
  return el.evaluate((node) => (node as HTMLInputElement).value ?? '')
}

async function typeFully(
  page: Page,
  selectors: string[],
  value: string,
  timeoutMs = 20000
): Promise<ElementHandle<Element>> {
  const el = await findVisible(page, selectors, timeoutMs)
  if (!el) throw new Error(`Không tìm thấy ô nhập (${selectors[0]})`)

  await humanClickHandle(page, el)
  await humanDelay(280, 550)

  // Xóa nội dung cũ (Ctrl+A → Backspace) với nhịp chậm
  await page.keyboard.down('Control')
  await humanDelay(40, 90)
  await page.keyboard.press('KeyA')
  await humanDelay(40, 90)
  await page.keyboard.up('Control')
  await humanDelay(80, 160)
  await page.keyboard.press('Backspace')
  await humanDelay(200, 420)

  await typeLikeHuman(page, value)
  await humanDelay(450, 900)

  let current = await readInputValue(el)
  if (current !== value) {
    // Thử gõ lại chậm hơn — tránh set value bằng JS (dấu hiệu bot)
    loginDebugLog('typeFully lệch, gõ lại', { got: current.length, need: value.length })
    await humanClickHandle(page, el)
    await humanDelay(200, 400)
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await humanDelay(250, 450)
    for (const ch of value) {
      await page.keyboard.type(ch, { delay: 0 })
      await humanDelay(140, 260)
    }
    await humanDelay(400, 700)
    current = await readInputValue(el)
  }

  if (current !== value) {
    // Fallback cuối: set value + event (chỉ khi gõ thất bại)
    await el.evaluate((node, v) => {
      const input = node as HTMLInputElement
      const proto = window.HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      desc?.set?.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
    await humanDelay(300, 500)
    current = await readInputValue(el)
  }

  if (current !== value) {
    await el.dispose()
    throw new Error(`Nhập chưa đủ giá trị (đã có "${current}", cần "${value}")`)
  }

  return el
}

/** Click Next đúng 1 lần, chờ trang tiến triển — tránh double-click khi lỗi mail */
async function clickNext(
  page: Page,
  preferredIds: string[],
  options?: { treatTotpAsPending?: boolean }
): Promise<void> {
  const beforeUrl = page.url()

  if (options?.treatTotpAsPending) {
    const pin = await page
      .evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[]
        const el = inputs.find((h) => {
          const aria = (h.getAttribute('aria-label') || '').toLowerCase()
          return (
            h.name === 'totpPin' ||
            h.id === 'totpPin' ||
            aria.includes('enter code') ||
            aria.includes('nhập mã') ||
            h.autocomplete === 'one-time-code'
          )
        })
        return (el?.value || '').replace(/\s+/g, '')
      })
      .catch(() => '')
    if (!/^\d{6}$/.test(pin)) {
      loginDebugLog('không bấm Next — ô 2FA chưa có 6 số', { len: pin.length })
      return
    }
  }

  let clicked = false
  for (const id of preferredIds) {
    const btn = await findVisible(page, [`#${id}`, `button#${id}`], 2500)
    if (btn) {
      await humanDelay(500, 1100)
      const usedMouse = await trustedMouseClick(page, btn)
      if (!usedMouse) {
        await btn.click({ delay: rand(40, 90) }).catch(() => undefined)
      }
      await btn.dispose()
      clicked = true
      break
    }
  }

  if (!clicked) {
    await humanDelay(300, 600)
    try {
      clicked = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll('button, div[role="button"], span[role="button"]')
        )
        const next = candidates.find((n) => {
          const t = (n.textContent || '').trim().toLowerCase()
          return t === 'next' || t === 'tiếp theo' || t === 'tiếp tục'
        }) as HTMLElement | undefined
        if (!next) return false
        if (next.dataset.cmClicked === '1') return true
        next.dataset.cmClicked = '1'
        next.click()
        return true
      })
    } catch (error) {
      if (isDestroyedContextError(error)) return
      throw error
    }
  }

  if (!clicked) {
    await humanDelay(200, 400)
    await page.keyboard.press('Enter')
  }

  const started = Date.now()
  while (Date.now() - started < 8000) {
    try {
      if (page.url() !== beforeUrl) return
      if (options?.treatTotpAsPending) {
        // Đang nộp TOTP: còn ô pin ≠ thành công; chờ URL đổi hoặc banner lỗi
        if (await pageShowsTotpRejected(page)) return
        await delay(250)
        continue
      }
      const pass = await findVisible(page, PASSWORD_SELECTORS, 400)
      if (pass) {
        await pass.dispose()
        return
      }
      const totp = await findVisible(page, TOTP_SELECTORS, 400)
      if (totp) {
        await totp.dispose()
        return
      }
      if (await hasManualTextCaptcha(page)) return
      await delay(250)
    } catch (error) {
      // Sau Next (đặc biệt 2FA) trang navigate → context destroyed = đã chuyển trang
      if (isDestroyedContextError(error)) {
        loginDebugLog('clickNext: navigation — coi như đã chuyển bước')
        return
      }
      throw error
    }
  }
}

async function waitForPasswordStep(
  page: Page,
  options?: { mailKind?: 'old' | 'new'; timeoutMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 25000
  // Captcha chữ → ưu tiên chờ user nhập (tới 3 phút)
  await waitForManualCaptchaIfNeeded(page)
  // Mail cũ & mail mới: gặp Confirm you’re not a robot → bấm checkbox, rồi vào ô pass
  await waitForPasswordStepAfterEmail(page, Math.max(timeoutMs, 45000))
}

async function pageHasRecaptchaCheckbox(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate(() => {
        return Boolean(
          document.querySelector(
            '.recaptcha-checkbox-borderAnimation, .recaptcha-checkbox-border, #recaptcha-anchor, .recaptcha-checkbox, [role="checkbox"]'
          )
        )
      })
      .catch(() => false)
    if (found) return true
  }
  return false
}

/** Bấm checkbox “I’m not a robot” (thường nằm trong iframe reCAPTCHA) */
async function clickImNotARobotCheckbox(page: Page): Promise<boolean> {
  const frames = [...page.frames()].sort((a, b) => {
    const score = (f: typeof a): number => {
      const u = f.url().toLowerCase()
      if (u.includes('recaptcha') && u.includes('anchor')) return 3
      if (u.includes('recaptcha')) return 2
      if (u.includes('bframe')) return 1
      return 0
    }
    return score(b) - score(a)
  })

  for (const frame of frames) {
    const clicked = await frame
      .evaluate(() => {
        const selectors = [
          '.recaptcha-checkbox-borderAnimation',
          '.recaptcha-checkbox-border',
          '#recaptcha-anchor',
          '.recaptcha-checkbox',
          'span[role="checkbox"]',
          'div[role="checkbox"]'
        ]
        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLElement | null
          if (!el) continue
          const r = el.getBoundingClientRect()
          if (r.width < 2 && r.height < 2) continue
          el.click()
          return sel
        }
        return ''
      })
      .catch(() => '')
    if (clicked) {
      loginDebugLog('click I’m not a robot', { frame: frame.url().slice(0, 80), sel: clicked })
      return true
    }
  }
  return false
}

/**
 * Sau Next email: nếu Confirm you’re not a robot → bấm checkbox, chờ ô pass.
 * Dùng chung cho mail cũ và mail mới.
 */
async function waitForPasswordStepAfterEmail(page: Page, timeoutMs: number): Promise<void> {
  const started = Date.now()
  let clickedRobot = false
  let lastClickAt = 0

  while (Date.now() - started < timeoutMs) {
    if (await hasManualTextCaptcha(page)) {
      await waitForManualCaptchaIfNeeded(page)
      continue
    }

    const pass = await findVisible(page, PASSWORD_SELECTORS, 700)
    if (pass) {
      await pass.dispose()
      if (clickedRobot) emitLoginProgress('Đã qua I’m not a robot → nhập mật khẩu', 'success')
      return
    }

    const text = await pageText(page)
    const robotUi = isRobotChallenge(text) || (await pageHasRecaptchaCheckbox(page))
    if (robotUi) {
      const now = Date.now()
      // Tránh spam click; cho phép thử lại sau ~3s nếu chưa có password
      if (!clickedRobot || now - lastClickAt > 3000) {
        if (!clickedRobot) {
          emitLoginProgress('Gặp Confirm you’re not a robot — bấm checkbox')
        }
        const ok = await clickImNotARobotCheckbox(page)
        if (ok) {
          clickedRobot = true
          lastClickAt = now
          await humanDelay(1800, 3200)
          continue
        }
        lastClickAt = now
      }
      await delay(800)
      continue
    }

    await delay(350)
  }

  const passLate = await findVisible(page, PASSWORD_SELECTORS, 2500)
  if (passLate) {
    await passLate.dispose()
    return
  }

  // Hết giờ vẫn kẹt robot → mới coi là lỗi
  await assertNotRobot(page)
  throw new Error('Không thấy ô mật khẩu sau khi nhập email (captcha / robot).')
}

/** Sau Next mật khẩu: chờ màn chọn 2FA / ô TOTP / đã login */
async function waitForChallengeAfterPassword(page: Page, timeoutMs = 20000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await isLoggedIn(page)) return
    if (await hasManualTextCaptcha(page)) {
      await waitForManualCaptchaIfNeeded(page)
      continue
    }
    if (await pageHasAuthenticatorChooser(page)) return
    const totp = await findVisible(page, TOTP_SELECTORS, 400)
    if (totp) {
      await totp.dispose()
      return
    }
    const url = page.url().toLowerCase()
    if (
      url.includes('challenge/selection') ||
      url.includes('challenge/totp') ||
      url.includes('challenge/dp') ||
      url.includes('selectchallenge')
    ) {
      await delay(300)
      if (await pageHasAuthenticatorChooser(page)) return
    }
    await delay(250)
  }
}

/** Trang marketing Workspace — KHÔNG phải Gmail app (vd. workspace.google.com/intl/.../gmail/#inbox) */
function isWorkspaceMarketingUrl(url: string): boolean {
  const u = url.toLowerCase()
  return (
    u.includes('workspace.google.com') ||
    u.includes('gmail.google.com/intl') ||
    (u.includes('/intl/') && u.includes('gmail') && !u.includes('mail.google.com/mail'))
  )
}

/** Đang ở Gmail web app thật (mail.google.com/mail/...) */
function isRealGmailAppUrl(url: string): boolean {
  const u = url.toLowerCase()
  if (isWorkspaceMarketingUrl(u)) return false
  if (u.includes('accounts.google.com')) return false
  return u.includes('mail.google.com/mail')
}

/** URL còn đang ở bước challenge đăng nhập? */
function isStillOnAuthChallenge(url: string): boolean {
  const u = url.toLowerCase()
  return (
    u.includes('/challenge/') ||
    u.includes('/identifier') ||
    u.includes('/pwd') ||
    u.includes('totppin') ||
    u.includes('flowentry=servicelogin')
  )
}

async function isLoggedIn(page: Page): Promise<boolean> {
  let url = ''
  try {
    url = page.url().toLowerCase()
  } catch {
    return false
  }
  // Landing Workspace ≠ đã vào hộp thư
  if (isWorkspaceMarketingUrl(url)) return false

  if (isRealGmailAppUrl(url)) return true
  // Passkey / Sign in faster / speedbump = đã xác thực xong, chỉ còn màn tùy chọn
  if (isPostAuthOptionalUrl(url)) return true
  if (url.includes('myaccount.google.com')) return true
  if (url.includes('accounts.google.com/signin/continue')) return true
  if (url.includes('accounts.google.com') && url.includes('checkcookie')) return true

  // Chỉ tin chữ "inbox/compose" khi đã ở mail.google.com (tránh dính trang quảng cáo)
  if (url.includes('mail.google.com') && !url.includes('accounts.google.com')) {
    const text = await pageText(page)
    if (text.includes('inbox') || text.includes('hộp thư đến')) return true
    if (text.includes('compose') || text.includes('soạn thư')) return true
  }
  return false
}

async function clickOptionalSkip(page: Page): Promise<boolean> {
  let url = ''
  try {
    url = page.url().toLowerCase()
  } catch {
    return false
  }
  // Không bấm lung tung trên trang login / captcha / marketing / đang nhập 2FA
  if (isWorkspaceMarketingUrl(url)) return false
  if (
    url.includes('/identifier') ||
    url.includes('/pwd') ||
    (url.includes('/challenge/totp') && !url.includes('passkey'))
  ) {
    return false
  }
  try {
    if (await hasManualTextCaptcha(page)) return false
  } catch (error) {
    if (isDestroyedContextError(error)) return false
    throw error
  }

  try {
    return await page.evaluate(() => {
      const allowedExact = new Set([
        'not now',
        'skip',
        'để sau',
        'bỏ qua',
        'cancel',
        'hủy',
        'no thanks',
        'không, cảm ơn',
        'không cảm ơn',
        'later',
        'maybe later'
      ])
      const allowedIncludes = [
        'not now',
        'skip for now',
        'remind me later',
        'để sau',
        'bỏ qua',
        'không phải bây giờ',
        "don't turn on",
        'dont turn on',
        "don't use",
        'dont use',
        'no thanks',
        'continue without',
        'không dùng',
        'không bật',
        'để lần sau'
      ]
      const nodes = Array.from(
        document.querySelectorAll('button, div[role="button"], span[role="button"], a')
      )
      const skip = nodes.find((n) => {
        const el = n as HTMLElement
        if (el.dataset.cmClicked === '1') return false
        const t = (el.textContent || el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        if (!t || t.length > 64) return false
        // Không bấm Continue/Next trên màn passkey (sẽ bật tạo khóa)
        if (t === 'continue' || t === 'tiếp tục' || t === 'next' || t === 'tiếp theo') return false
        if (t.includes('create') || t.includes('tạo khóa') || t.includes('turn on')) return false
        if (allowedExact.has(t)) return true
        return allowedIncludes.some((a) => t === a || t.startsWith(a) || t.includes(a))
      }) as HTMLElement | undefined
      if (!skip) return false
      skip.dataset.cmClicked = '1'
      skip.click()
      return true
    })
  } catch (error) {
    if (isDestroyedContextError(error)) return false
    throw error
  }
}

/** Màn "2-Step Verification" → chọn phương thức (Authenticator / Tap Yes / Try another way) */
function isTwoStepVerificationChooser(text: string, url = ''): boolean {
  const t = text.toLowerCase()
  const u = url.toLowerCase()
  if (u.includes('challenge/totp') || u.includes('totppin')) return false

  const hasAuthenticatorOption =
    t.includes('google authenticator') ||
    t.includes('authenticator app') ||
    t.includes('get a verification code') ||
    t.includes('ứng dụng xác thực') ||
    t.includes('mã từ ứng dụng') ||
    t.includes('authentication app')

  if (!hasAuthenticatorOption) return false

  return (
    t.includes('2-step verification') ||
    t.includes('two-step verification') ||
    t.includes('xác minh 2 bước') ||
    t.includes('choose how you want') ||
    t.includes('chọn cách bạn muốn') ||
    t.includes('try another way') ||
    t.includes('thử cách khác') ||
    u.includes('challenge/selection') ||
    u.includes('selectchallenge') ||
    u.includes('challenge/dp')
  )
}

/**
 * Option Authenticator — DOM Google:
 * <div jsname="EBHGs" data-action="selectchallenge" data-challengetype="6" role="link">
 *   <div jsname="fmcmS">Get a verification code from the Google Authenticator app</div>
 * </div>
 * Selector lỏng dần: type=6 trước, rồi jsname+text, rồi text thuần.
 */
const AUTHENTICATOR_OPTION_SELECTORS = [
  '[data-challengetype="6"][data-action="selectchallenge"]:not([aria-disabled="true"]):not([data-challengeunavailable])',
  '[jsname="EBHGs"][data-challengetype="6"]:not([aria-disabled="true"]):not([data-challengeunavailable])',
  '[jsname="EBHGs"][data-action="selectchallenge"]:not([aria-disabled="true"]):not([data-challengeunavailable])',
  '[data-action="selectchallenge"][role="link"]:not([aria-disabled="true"]):not([data-challengeunavailable])'
]

type AuthTarget = { frame: Frame; handle: ElementHandle<Element>; selector: string }

async function dumpAuthenticatorDom(page: Page): Promise<void> {
  try {
    const dump = await page.evaluate(() => {
      const pick = (el: Element) => {
        const h = el as HTMLElement
        const r = h.getBoundingClientRect()
        return {
          tag: h.tagName,
          jsname: h.getAttribute('jsname'),
          action: h.getAttribute('data-action'),
          type: h.getAttribute('data-challengetype'),
          id: h.getAttribute('data-challengeid'),
          disabled: h.getAttribute('aria-disabled'),
          unavailable: h.hasAttribute('data-challengeunavailable'),
          role: h.getAttribute('role'),
          text: (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        }
      }
      return {
        url: location.href,
        title: document.title,
        ebhgs: Array.from(document.querySelectorAll('[jsname="EBHGs"]')).map(pick),
        type6: Array.from(document.querySelectorAll('[data-challengetype="6"]')).map(pick),
        selectchallenge: Array.from(document.querySelectorAll('[data-action="selectchallenge"]')).map(
          pick
        )
      }
    })
    loginDebugLog('DOM chooser', dump)
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue
      const extra = await frame
        .evaluate(() => ({
          url: location.href,
          ebhgs: document.querySelectorAll('[jsname="EBHGs"]').length,
          type6: document.querySelectorAll('[data-challengetype="6"]').length,
          selectchallenge: document.querySelectorAll('[data-action="selectchallenge"]').length,
          text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        }))
        .catch(() => null)
      if (extra && (extra.ebhgs || extra.type6 || extra.selectchallenge || extra.text)) {
        loginDebugLog('iframe', extra)
      }
    }
  } catch (error) {
    loginDebugLog('dump DOM lỗi', error instanceof Error ? error.message : String(error))
  }
}

async function findAuthenticatorTarget(page: Page): Promise<AuthTarget | null> {
  if (isTotpChallengeUrl(page.url())) return null

  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())]
  for (const frame of frames) {
    for (const selector of AUTHENTICATOR_OPTION_SELECTORS) {
      const handles = await frame.$$(selector).catch(() => [])
      for (const handle of handles) {
        const info = await handle
          .evaluate((el) => {
            const h = el as HTMLElement
            if (h.getAttribute('aria-disabled') === 'true') return null
            if (h.hasAttribute('data-challengeunavailable')) return null
            const r = h.getBoundingClientRect()
            if (r.width < 8 || r.height < 8) return null
            const text = (h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
            return {
              type: h.getAttribute('data-challengetype') || '',
              action: h.getAttribute('data-action') || '',
              jsname: h.getAttribute('jsname') || '',
              text,
              w: Math.round(r.width),
              hgt: Math.round(r.height)
            }
          })
          .catch(() => null)
        if (!info) {
          await handle.dispose()
          continue
        }
        const isAuth =
          info.type === '6' ||
          info.text.includes('google authenticator') ||
          info.text.includes('ứng dụng xác thực') ||
          (info.text.includes('get a verification code') && info.text.includes('authenticator'))
        const isTapYes =
          info.text.includes('tap yes') ||
          info.text.includes('device can') ||
          info.text.includes('chạm vào có')
        if (isAuth && !isTapYes) {
          return { frame, handle, selector }
        }
        await handle.dispose()
      }
    }

    const byText = await frame
      .evaluateHandle(() => {
        const nodes = Array.from(
          document.querySelectorAll(
            '[data-action="selectchallenge"], [jsname="EBHGs"][role="link"], [jsname="EBHGs"][data-challengetype]'
          )
        )
        for (const node of nodes) {
          const h = node as HTMLElement
          if (h.getAttribute('aria-disabled') === 'true') continue
          if (h.hasAttribute('data-challengeunavailable')) continue
          const text = (h.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (!text || text.length > 140) continue
          if (text.includes('tap yes') || text.includes('chạm vào có')) continue
          if (
            h.getAttribute('data-challengetype') === '6' ||
            text.includes('google authenticator') ||
            text.includes('ứng dụng xác thực') ||
            (text.includes('get a verification code') && text.includes('authenticator'))
          ) {
            return h
          }
        }
        return null
      })
      .catch(() => null)
    const el = byText?.asElement() as ElementHandle<Element> | null
    if (el) return { frame, handle: el, selector: 'text:google authenticator' }
    await byText?.dispose().catch(() => undefined)
  }
  return null
}

async function pageHasAuthenticatorChooser(page: Page): Promise<boolean> {
  if (isTotpChallengeUrl(page.url())) return false
  const target = await findAuthenticatorTarget(page)
  if (!target) return false
  await target.handle.dispose()
  return true
}

async function authenticatorStepAdvanced(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase()
  if (isTotpChallengeUrl(url)) return true
  const pin = await findVisible(page, TOTP_SELECTORS, 350)
  if (pin) {
    await pin.dispose()
    return true
  }
  if (url.includes('challenge/selection')) return false
  return false
}

async function waitAuthenticatorAdvanced(page: Page, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await authenticatorStepAdvanced(page)) return true
    await delay(250)
  }
  return false
}

/** Click thật qua page.mouse (trusted) — CDP session phụ không kích hoạt jsaction của Google */
async function trustedMouseClick(page: Page, handle: ElementHandle<Element>): Promise<boolean> {
  await handle.evaluate((el) => {
    ;(el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' })
  })
  await delay(150)
  const box = await handle.boundingBox()
  if (!box || box.width < 4 || box.height < 4) {
    loginDebugLog('boundingBox trống', box)
    return false
  }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  loginDebugLog('mouse.click', {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(box.width),
    h: Math.round(box.height)
  })
  await page.mouse.move(x, y, { steps: 6 })
  await delay(40)
  await page.mouse.click(x, y, { delay: 50 })
  return true
}

/** Bấm "Get a verification code from the Google Authenticator app" */
async function clickGoogleAuthenticatorOption(page: Page): Promise<boolean> {
  await page.bringToFront().catch(() => undefined)
  if (await authenticatorStepAdvanced(page)) {
    loginDebugLog('đã ở bước nhập TOTP', { url: page.url() })
    return true
  }
  const started = Date.now()
  loginDebugLog('bắt đầu click Authenticator', { url: page.url() })
  emitLoginProgress('Chọn Google Authenticator')
  await dumpAuthenticatorDom(page)

  while (Date.now() - started < 20000) {
    if (await authenticatorStepAdvanced(page)) {
      loginDebugLog('đã qua bước chọn', { url: page.url() })
      return true
    }

    const target = await findAuthenticatorTarget(page)
    if (!target) {
      loginDebugLog('chưa thấy option Authenticator', { url: page.url() })
      await dumpAuthenticatorDom(page)
      await delay(400)
      continue
    }

    loginDebugLog('tìm thấy option', { selector: target.selector, url: page.url() })
    try {
      await trustedMouseClick(page, target.handle)
      if (await waitAuthenticatorAdvanced(page, 3500)) {
        loginDebugLog('mouse.click thành công', { url: page.url() })
        return true
      }

      const label = await target.handle.$('[jsname="fmcmS"], .l5PPKe')
      if (label) {
        loginDebugLog('thử click nhãn fmcmS')
        await trustedMouseClick(page, label)
        await label.dispose()
        if (await waitAuthenticatorAdvanced(page, 3000)) {
          loginDebugLog('click nhãn thành công', { url: page.url() })
          return true
        }
      }

      await target.handle.click({ delay: 60 }).catch((error) => {
        loginDebugLog('handle.click lỗi', error instanceof Error ? error.message : String(error))
      })
      if (await waitAuthenticatorAdvanced(page, 2500)) {
        loginDebugLog('handle.click thành công', { url: page.url() })
        return true
      }

      await target.handle.focus().catch(() => undefined)
      await delay(80)
      await page.keyboard.press('Enter').catch(() => undefined)
      if (await waitAuthenticatorAdvanced(page, 2000)) {
        loginDebugLog('Enter thành công', { url: page.url() })
        return true
      }
      await page.keyboard.press('Space').catch(() => undefined)
      if (await waitAuthenticatorAdvanced(page, 2000)) {
        loginDebugLog('Space thành công', { url: page.url() })
        return true
      }

      const selClick = await page
        .click(
          '[data-challengetype="6"][data-action="selectchallenge"]:not([aria-disabled="true"])',
          { delay: 40 }
        )
        .then(() => true)
        .catch(() => false)
      if (selClick && (await waitAuthenticatorAdvanced(page, 2500))) {
        loginDebugLog('page.click selector thành công', { url: page.url() })
        return true
      }

      loginDebugLog('click chưa chuyển trang', { url: page.url() })
    } finally {
      await target.handle.dispose().catch(() => undefined)
    }

    await delay(400)
  }

  loginDebugLog('fallback navigate selection→totp', { url: page.url() })
  if (await navigateSelectionToTotp(page)) return true
  await dumpAuthenticatorDom(page)
  return false
}

/** Fallback: đổi URL selection → totp (giữ query + cid) — chỉ khi còn đứng màn chọn */
async function navigateSelectionToTotp(page: Page): Promise<boolean> {
  const url = page.url()
  const lower = url.toLowerCase()
  if (lower.includes('challenge/totp') || lower.includes('totppin')) {
    return waitAuthenticatorAdvanced(page, 3000)
  }
  if (!lower.includes('challenge/selection') && !lower.includes('/challenge/dp')) {
    return false
  }
  const cid = await page
    .evaluate(() => {
      const el = document.querySelector(
        '[data-challengetype="6"][data-action="selectchallenge"]'
      ) as HTMLElement | null
      return el?.getAttribute('data-challengeid') || ''
    })
    .catch(() => '')

  let next = url
    .replace(/\/challenge\/selection/i, '/challenge/totp')
    .replace(/\/challenge\/dp/i, '/challenge/totp')
  if (cid && !/[?&]cid=/.test(next)) {
    next += (next.includes('?') ? '&' : '?') + `cid=${encodeURIComponent(cid)}`
  }
  if (next === url) return false
  loginDebugLog('goto totp', { from: url, to: next })
  await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => undefined)
  await delay(1200)
  return waitAuthenticatorAdvanced(page, 5000)
}

function isAuthenticatorOptionText(text: string): boolean {
  const t = text.toLowerCase()
  if (t.includes('get a verification code at')) return false
  if (t.includes('tap yes on your phone')) return false
  return (
    t.includes('google authenticator') ||
    t.includes('authenticator app') ||
    (t.includes('get a verification code') && t.includes('authenticator')) ||
    t.includes('ứng dụng xác thực') ||
    t.includes('mã từ ứng dụng')
  )
}

function shouldClickAuthenticatorChooser(text: string, url: string): boolean {
  if (isTwoStepVerificationChooser(text, url)) return true
  const u = url.toLowerCase()
  if (u.includes('challenge/totp') || u.includes('totppin')) return false
  if (!isAuthenticatorOptionText(text)) return false
  return (
    text.includes('choose how you want') ||
    text.includes('2-step verification') ||
    text.includes('two-step verification') ||
    u.includes('challenge/dp') ||
    u.includes('challenge/selection') ||
    u.includes('selectchallenge')
  )
}

/**
 * Click phần tử theo nhãn — ưu tiên nhãn ngắn nhất để tránh bấm container cha.
 */
async function clickByText(
  page: Page,
  texts: string[],
  timeoutMs = 8000,
  avoid: string[] = []
): Promise<boolean> {
  const started = Date.now()
  const lowered = texts.map((t) => t.toLowerCase())
  const blocked = avoid.map((t) => t.toLowerCase())
  while (Date.now() - started < timeoutMs) {
    const clicked = await page
      .evaluate(
        (needles, blockList) => {
          const nodes = Array.from(
            document.querySelectorAll(
              'button, a, div[role="button"], div[role="link"], span[role="button"], li, li[role="menuitem"], div[role="menuitem"], [data-action="selectchallenge"], input[type="submit"]'
            )
          )
          const candidates: Array<{ el: HTMLElement; label: string }> = []
          for (const node of nodes) {
            const el = node as HTMLElement
            const label = (el.innerText || el.getAttribute('aria-label') || '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase()
            if (!label || label.length > 120) continue
            if (blockList.some((b) => label.includes(b))) continue
            if (!needles.some((n) => label.includes(n))) continue
            const style = window.getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden') continue
            const rect = el.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) continue
            if (el.getAttribute('aria-disabled') === 'true') continue
            if (el.hasAttribute('data-challengeunavailable')) continue
            candidates.push({ el, label })
          }
          if (candidates.length === 0) return false
          candidates.sort((a, b) => a.label.length - b.label.length)
          const target = candidates[0].el
          target.dispatchEvent(
            new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window
            })
          )
          target.dispatchEvent(
            new PointerEvent('pointerup', {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window
            })
          )
          target.dispatchEvent(
            new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              composed: true,
              view: window
            })
          )
          target.click()
          return true
        },
        lowered,
        blocked
      )
      .catch(() => false)
    if (clicked) return true
    await delay(300)
  }
  return false
}

async function dumpTotpInputs(page: Page): Promise<void> {
  try {
    const dump = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map((node) => {
        const h = node as HTMLInputElement
        const r = h.getBoundingClientRect()
        return {
          name: h.name,
          id: h.id,
          type: h.type,
          max: h.maxLength,
          auto: h.autocomplete,
          aria: h.getAttribute('aria-label'),
          jsname: h.getAttribute('jsname'),
          valueLen: (h.value || '').length,
          vis: r.width > 0 && r.height > 0,
          w: Math.round(r.width),
          hgt: Math.round(r.height)
        }
      })
    )
    loginDebugLog('DOM totp inputs', dump)
  } catch (error) {
    loginDebugLog('dump totp lỗi', error instanceof Error ? error.message : String(error))
  }
}

async function findTotpInput(page: Page, timeoutMs: number): Promise<ElementHandle<Element> | null> {
  const el = await findVisible(page, TOTP_SELECTORS, Math.min(timeoutMs, 6000))
  if (el) return el

  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const handle = await page
      .evaluateHandle(() => {
        const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[]
        return (
          inputs.find((h) => {
            if (h.type === 'hidden' || h.type === 'checkbox' || h.type === 'radio' || h.type === 'password') {
              return false
            }
            const r = h.getBoundingClientRect()
            if (r.width < 8 || r.height < 8) return false
            const aria = (h.getAttribute('aria-label') || '').toLowerCase()
            const placeholder = (h.getAttribute('placeholder') || '').toLowerCase()
            return (
              h.name === 'totpPin' ||
              h.id === 'totpPin' ||
              h.maxLength === 6 ||
              h.maxLength === 8 ||
              aria.includes('enter code') ||
              aria.includes('nhập mã') ||
              placeholder.includes('code') ||
              h.inputMode === 'numeric' ||
              h.type === 'tel'
            )
          }) || null
        )
      })
      .catch(() => null)
    const el2 = handle?.asElement() as ElementHandle<Element> | null
    if (el2) return el2
    await handle?.dispose().catch(() => undefined)
    await delay(250)
  }
  return null
}

/** Gõ mã 6 số vào ô "Enter code" — keyboard thật + native setter */
async function fillTotpCode(page: Page, code: string): Promise<boolean> {
  await dumpTotpInputs(page)
  const el = await findTotpInput(page, 10000)
  if (!el) {
    loginDebugLog('không thấy ô totp')
    return false
  }

  await humanClickHandle(page, el)
  await humanDelay(200, 400)
  await el.focus().catch(() => undefined)
  await humanDelay(100, 200)

  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await humanDelay(120, 250)
  await typeLikeHuman(page, code)
  await humanDelay(250, 500)

  await page.evaluate((pin) => {
    const pick = Array.from(document.querySelectorAll('input')) as HTMLInputElement[]
    const targets = pick.filter((h) => {
      if (h.type === 'hidden' || h.type === 'checkbox' || h.type === 'radio' || h.type === 'password') {
        return false
      }
      const r = h.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return false
      const aria = (h.getAttribute('aria-label') || '').toLowerCase()
      return (
        h.name === 'totpPin' ||
        h.id === 'totpPin' ||
        h.maxLength === 6 ||
        h.maxLength === 8 ||
        aria.includes('enter code') ||
        aria.includes('nhập mã') ||
        h.autocomplete === 'one-time-code'
      )
    })
    const active = document.activeElement instanceof HTMLInputElement ? document.activeElement : null
    const list = active && !targets.includes(active) ? [active, ...targets] : targets
    for (const input of list) {
      const proto = window.HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      desc?.set?.call(input, pin)
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: pin, inputType: 'insertText' }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }, code)

  let typed = await readInputValue(el)
  loginDebugLog('totp sau khi gõ', {
    len: typed.replace(/\s+/g, '').length,
    ok: typed.replace(/\s+/g, '') === code
  })
  if (typed.replace(/\s+/g, '') !== code) {
    await el.focus().catch(() => undefined)
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await humanDelay(150, 300)
    await typeLikeHuman(page, code)
    await humanDelay(200, 400)
    typed = await readInputValue(el)
    loginDebugLog('totp gõ lần 2', {
      len: typed.replace(/\s+/g, '').length,
      ok: typed.replace(/\s+/g, '') === code
    })
  }
  await el.dispose()
  return typed.replace(/\s+/g, '') === code
}

function looksLikeRecoveryChallenge(text: string, url: string): boolean {
  if (isTwoStepVerificationChooser(text, url)) return false
  const u = url.toLowerCase()
  if (u.includes('knowledge') || u.includes('recovery')) return true
  return (
    text.includes('recovery email') ||
    text.includes('email khôi phục') ||
    text.includes('confirm your recovery email') ||
    text.includes('confirm the email address') ||
    text.includes('xác nhận email khôi phục') ||
    text.includes('xác nhận địa chỉ email') ||
    text.includes('get a verification code at')
  )
}

/**
 * Xử lý challenge sau mật khẩu.
 * Sau khi 2FA (TOTP) xong → coi như đã vào tài khoản: bỏ recovery email, đi thẳng Gmail.
 * Mã 2FA sai → bỏ qua mail, thử mail khác.
 */
async function handlePostPasswordChallenges(
  page: Page,
  gmail: GmailCredentials
): Promise<{ totpSubmitted: boolean }> {
  let totpSubmitted = false
  let totpAttempts = 0

  async function submitTotpOrSkip(): Promise<void> {
    const field = resolveTotpSecret(gmail)
    if (!field) {
      throw new SkipLoginError(
        `Thiếu mã 2FA 6 số (cột 3) cho ${gmail.email} — bỏ qua mail này.`
      )
    }
    let code: string
    if (isSixDigitCode(field)) {
      code = field.replace(/\s+/g, '')
    } else {
      try {
        code = await generateTotp(field)
      } catch {
        throw new SkipLoginError(
          `Mã 2FA không hợp lệ cho ${gmail.email} — cần 6 chữ số ở cột 3. Bỏ qua.`
        )
      }
    }
    if (!/^\d{6}$/.test(code)) {
      throw new SkipLoginError(
        `Mã 2FA không phải 6 chữ số cho ${gmail.email} — bỏ qua.`
      )
    }

    totpAttempts += 1
    loginDebugLog('submit totp', { codeLen: code.length, url: page.url() })
    emitLoginProgress('Nhập & nộp mã 2FA')
    const filled = await fillTotpCode(page, code)
    if (!filled) {
      throw new SkipLoginError(
        `Không nhập được mã 2FA vào ô (${gmail.email}) — bỏ qua mail này.`
      )
    }

    await delay(250)
    // Đánh dấu đã nộp trước khi chờ navigate — context destroyed ≠ mã sai
    totpSubmitted = true
    try {
      await clickNext(
        page,
        ['totpNext', 'idvPreregisteredPhoneNext', 'idvanywhereverifyNext'],
        { treatTotpAsPending: true }
      )
    } catch (error) {
      if (!isDestroyedContextError(error)) throw error
      loginDebugLog('clickNext totp: navigation — 2FA đã nộp')
    }
    await delay(2000)

    // Sau Next 2FA trang hay nhảy Sign in faster / passkey — chờ navigation
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => undefined)
    await delay(600)

    try {
      if (await pageShowsTotpRejected(page)) {
        throw new SkipLoginError(
          `Mã 2FA không chính xác (${gmail.email}) — bỏ qua mail này để thử mail khác.`
        )
      }
    } catch (error) {
      if (error instanceof SkipLoginError) throw error
      if (!isDestroyedContextError(error)) throw error
      loginDebugLog('totp check: navigation — bỏ qua kiểm tra mã sai')
    }

    // Đã qua 2FA → màn tùy chọn / inbox
    try {
      const afterUrl = page.url()
      if (isPostAuthOptionalUrl(afterUrl) || (await isLoggedIn(page))) {
        emitLoginProgress('2FA OK — bỏ màn Sign in faster / speedbump')
        await clickOptionalSkip(page).catch(() => false)
        await delay(500)
        await clickOptionalSkip(page).catch(() => false)
        return
      }
    } catch (error) {
      if (isDestroyedContextError(error)) {
        loginDebugLog('sau 2FA: context destroyed — coi như login OK')
        return
      }
      throw error
    }
  }

  for (let step = 0; step < 16; step++) {
    try {
      await delay(totpSubmitted ? 800 : 1200)
      if (await isLoggedIn(page)) {
        if (totpSubmitted || isPostAuthOptionalUrl(page.url())) {
          await clickOptionalSkip(page).catch(() => false)
        }
        return { totpSubmitted }
      }

      const url = page.url()
      const onTotpUrl = isTotpChallengeUrl(url)

      loginDebugLog(`challenge step=${step}`, {
        url,
        onTotpUrl,
        totpSubmitted,
        hasSecret: Boolean(resolveTotpSecret(gmail)),
        secretLen: resolveTotpSecret(gmail).length,
        rawParts: (gmail.raw || '').split('|').length
      })

      // Đã nộp 2FA + đang ở Sign in faster / passkey / speedbump → skip & xong
      if (totpSubmitted && (isPostAuthOptionalUrl(url) || isSignInFasterText(await pageText(page)))) {
        emitLoginProgress('Bỏ qua Sign in faster / passkey → inbox')
        await clickOptionalSkip(page).catch(() => false)
        await delay(600)
        await clickOptionalSkip(page).catch(() => false)
        return { totpSubmitted }
      }

      // Màn chọn Authenticator (DOM type=6) — LUÔN bấm, không chờ có secret
      const chooserVisible = !onTotpUrl && (await pageHasAuthenticatorChooser(page))
      loginDebugLog('chooserVisible', chooserVisible)
      if (chooserVisible) {
        const clicked = await clickGoogleAuthenticatorOption(page)
        if (!clicked && !isTotpChallengeUrl(page.url())) {
          throw new SkipLoginError(
            `Không bấm được option Google Authenticator (${gmail.email}) — bỏ qua mail này.`
          )
        }
        continue
      }

      // Ưu tiên ô/URL TOTP TRƯỚC assertNotRobot — tránh false "mã sai" rồi refresh
      let totpField = await findTotpInput(page, onTotpUrl ? 5000 : 1500)
      if (!totpField && onTotpUrl) {
        await dumpTotpInputs(page)
        await delay(800)
        totpField = await findTotpInput(page, 8000)
      }

      if (totpField || onTotpUrl) {
        if (totpField) await totpField.dispose()
        if (!totpField) {
          loginDebugLog('totp url nhưng chưa thấy ô', { url: page.url() })
          continue
        }

        if (totpSubmitted) {
          if (await pageShowsTotpRejected(page)) {
            throw new SkipLoginError(
              `Mã 2FA không chính xác (${gmail.email}) — bỏ qua mail này để thử mail khác.`
            )
          }
          if (totpAttempts >= 2) {
            throw new SkipLoginError(
              `Không vượt qua bước nhập mã 2FA (${gmail.email}) — bỏ qua mail này.`
            )
          }
          await submitTotpOrSkip()
          continue
        }

        await submitTotpOrSkip()
        if (await isLoggedIn(page)) {
          await clickOptionalSkip(page).catch(() => false)
          return { totpSubmitted }
        }

        if (await pageShowsTotpRejected(page)) {
          throw new SkipLoginError(
            `Mã 2FA không chính xác (${gmail.email}) — bỏ qua mail này để thử mail khác.`
          )
        }
        const afterText = await pageText(page)
        const afterUrl = page.url()
        if (isPhoneVerificationRequired(afterText, afterUrl)) {
          throw new SkipLoginError('Sau 2FA Google vẫn bắt xác minh SĐT — bỏ qua.')
        }
        if (looksLikeRecoveryChallenge(afterText, afterUrl)) {
          await clickOptionalSkip(page)
          return { totpSubmitted }
        }
        if (isPostAuthOptionalUrl(afterUrl) || isSignInFasterText(afterText)) {
          await clickOptionalSkip(page).catch(() => false)
          return { totpSubmitted }
        }
        if (!isStillOnAuthChallenge(afterUrl) && !isWorkspaceMarketingUrl(afterUrl)) {
          await clickOptionalSkip(page)
          return { totpSubmitted }
        }
        continue
      }

      await assertNotRobot(page, {
        ignorePhone: totpSubmitted,
        ignoreTotpError: !totpSubmitted
      })

      const text = await pageText(page)

      // ——— Đã nộp 2FA thành công: không đụng recovery, skip speedbump → mở inbox ———
      if (totpSubmitted) {
        if (isPhoneVerificationRequired(text, url)) {
          throw new SkipLoginError('Sau 2FA Google vẫn bắt xác minh SĐT — bỏ qua.')
        }
        if (looksLikeRecoveryChallenge(text, url)) {
          await clickOptionalSkip(page)
          await delay(400)
          return { totpSubmitted }
        }
        if (
          isPostAuthOptionalUrl(url) ||
          isSignInFasterText(text) ||
          !isStillOnAuthChallenge(url) ||
          url.includes('myaccount.google.com')
        ) {
          await clickOptionalSkip(page).catch(() => false)
          await delay(400)
          await clickOptionalSkip(page).catch(() => false)
          return { totpSubmitted }
        }
        await clickOptionalSkip(page).catch(() => false)
        return { totpSubmitted }
      }

      // Màn chọn phương thức — không chạy khi đã vào totp
      if (shouldClickAuthenticatorChooser(text, url) && !onTotpUrl) {
        const clicked = await clickGoogleAuthenticatorOption(page)
        if (!clicked) {
          throw new SkipLoginError(
            `Không bấm được option Google Authenticator (${gmail.email}) — bỏ qua mail này.`
          )
        }
        const totpAfter = await findVisible(page, TOTP_SELECTORS, 15000)
        if (totpAfter) await totpAfter.dispose()
        continue
      }

      // Chỉ đi recovery khi CHƯA làm 2FA và không có secret TOTP
      if (looksLikeRecoveryChallenge(text, url)) {
        if (resolveTotpSecret(gmail)) {
          const clicked = await clickGoogleAuthenticatorOption(page)
          if (!clicked) {
            await clickByText(page, ['try another way', 'thử cách khác'], 3000)
          }
          await delay(800)
          continue
        }
        if (!gmail.recoveryEmail) {
          throw new Error('Google yêu cầu email khôi phục nhưng hồ sơ chưa có.')
        }
        const el = await typeFully(
          page,
          [
            'input[name="knowledgePreregisteredEmailResponse"]',
            'input[id="knowledge-preregistered-email-response"]',
            'input[type="email"]'
          ],
          gmail.recoveryEmail,
          10000
        )
        await el.dispose()
        await clickNext(page, ['idvPreregisteredEmailNext', 'idvanywhereverifyNext'])
        continue
      }

      // Speedbump tùy chọn (thêm SĐT, lưu thiết bị...) → Not now / Skip
      if (!isStillOnAuthChallenge(url) || isPostAuthOptionalUrl(url)) {
        const skippedOptional = await clickOptionalSkip(page)
        if (skippedOptional) {
          await delay(1000)
          continue
        }
      }
    } catch (error) {
      if (totpSubmitted && isDestroyedContextError(error)) {
        loginDebugLog('challenge step: navigation sau 2FA — coi như OK', {
          message: error instanceof Error ? error.message : String(error)
        })
        return { totpSubmitted }
      }
      throw error
    }
  }

  return { totpSubmitted }
}

async function ensureRealGmailInbox(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    let url = ''
    try {
      url = page.url()
    } catch (error) {
      if (isDestroyedContextError(error)) {
        await delay(1000)
        continue
      }
      throw error
    }

    if (isWorkspaceMarketingUrl(url)) {
      await page.goto(GMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(
        () => undefined
      )
      await delay(1500)
    } else if (!isRealGmailAppUrl(url)) {
      // Còn kẹt Sign in faster / speedbump → skip rồi mới goto inbox
      if (isPostAuthOptionalUrl(url)) {
        await clickOptionalSkip(page).catch(() => false)
        await delay(600)
      }
      await page.goto(GMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(
        () => undefined
      )
      await delay(1500)
    }

    try {
      url = page.url()
    } catch {
      await delay(800)
      continue
    }

    if (isRealGmailAppUrl(url)) {
      if (!url.toLowerCase().includes('#inbox')) {
        await page.goto(GMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(
          () => undefined
        )
        await delay(600)
      }
      return
    }

    await clickOptionalSkip(page).catch(() => false)
    await delay(800)
  }

  let finalUrl = ''
  try {
    finalUrl = page.url()
  } catch {
    // ignore
  }
  if (!isRealGmailAppUrl(finalUrl)) {
    throw new Error(
      'Chưa vào được Gmail inbox (mail.google.com). Có thể đang kẹt trang Workspace/marketing.'
    )
  }
}

/**
 * Luồng chuẩn:
 * 1) Vào trang đăng nhập Google trước
 * 2) Nhập mail/pass/2fa
 * 3) Thành công mới mở https://mail.google.com/mail/u/0/#inbox
 */
async function performLogin(
  page: Page,
  gmail: GmailCredentials,
  options?: { preferExistingSession?: boolean; mailKind?: 'old' | 'new' }
): Promise<void> {
  const mailKind = options?.mailKind === 'new' ? 'new' : 'old'

  // Mở lại hồ sơ đã login sẵn: chỉ giữ session nếu đang ở Gmail thật
  if (options?.preferExistingSession) {
    if (isRealGmailAppUrl(page.url())) {
      await ensureRealGmailInbox(page)
      return
    }
    await page.goto(GMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined)
    await delay(1200)
    if (isRealGmailAppUrl(page.url())) {
      await ensureRealGmailInbox(page)
      return
    }
  }

  // Luôn bắt đầu từ trang đăng nhập (không nhảy inbox trước)
  emitLoginProgress(
    mailKind === 'new' ? 'Mở trang đăng nhập Google (mail mới)' : 'Mở trang đăng nhập Google'
  )
  await resetToLoginPage(page)
  await humanDelay(700, 1400)
  await assertNotRobot(page)

  emitLoginProgress('Nhập email (chậm, giống tay)')
  const emailInput = await typeFully(page, EMAIL_SELECTORS, gmail.email, 20000)
  await humanDelay(600, 1200)
  const emailValue = await readInputValue(emailInput)
  await emailInput.dispose()
  if (emailValue !== gmail.email) {
    throw new Error('Email chưa nhập xong — không bấm Next.')
  }
  await assertNotRobot(page)
  await humanDelay(400, 900)
  await clickNext(page, ['identifierNext'])
  await humanDelay(1200, 2200)
  await waitForManualCaptchaIfNeeded(page)
  await waitForPasswordStep(page, { mailKind })
  await humanDelay(500, 1000)

  emitLoginProgress('Nhập mật khẩu (chậm, giống tay)')
  const passInput = await typeFully(page, PASSWORD_SELECTORS, gmail.password, 20000)
  await humanDelay(700, 1400)
  const passValue = await readInputValue(passInput)
  await passInput.dispose()
  if (passValue !== gmail.password) {
    throw new Error('Mật khẩu chưa nhập xong — không bấm Next.')
  }
  await assertNotRobot(page)
  await humanDelay(500, 1100)
  await clickNext(page, ['passwordNext'])
  await humanDelay(1200, 2400)
  await assertNotRobot(page)
  await waitForChallengeAfterPassword(page)

  emitLoginProgress('Xử lý xác minh sau mật khẩu (2FA / challenge)')
  let totpSubmitted = false
  try {
    ;({ totpSubmitted } = await handlePostPasswordChallenges(page, gmail))
  } catch (error) {
    if (!isDestroyedContextError(error)) throw error
    loginDebugLog('performLogin: navigation sau challenge — tiếp tục inbox')
    await delay(800)
    try {
      const url = page.url()
      if (
        isPostAuthOptionalUrl(url) ||
        isRealGmailAppUrl(url) ||
        (await isLoggedIn(page))
      ) {
        totpSubmitted = true
      } else {
        throw error
      }
    } catch (inner) {
      if (!isDestroyedContextError(inner)) throw inner
      // Vẫn thử vào inbox — thường đã login xong
      totpSubmitted = true
    }
  }

  try {
    await assertNotRobot(page, { ignorePhone: totpSubmitted, ignoreTotpError: !totpSubmitted })
  } catch (error) {
    if (!isDestroyedContextError(error)) throw error
  }

  // Sau 2FA (hoặc login xong): bỏ màn hình phụ rồi vào inbox — không đi recovery nữa
  if (totpSubmitted) {
    await clickOptionalSkip(page).catch(() => false)
    await humanDelay(500, 900)
    await clickOptionalSkip(page).catch(() => false)
  }

  // Chỉ SAU khi login xong mới vào inbox
  emitLoginProgress('Vào Gmail inbox')
  await ensureRealGmailInbox(page)
}

export async function loginGmailForProfile(
  profileId: string,
  options?: GmailLoginOptions
): Promise<GmailLoginResult> {
  const db = getDb()
  const profile = db.getProfile(profileId)
  if (!profile) {
    return { profileId, success: false, error: 'Không tìm thấy hồ sơ' }
  }

  const gmail = normalizeGmail(options?.credentials) ?? profile.gmail
  if (!hasGmailCredentials(gmail)) {
    return {
      profileId,
      success: false,
      error: 'Hồ sơ chưa có thông tin Gmail (cần email và mật khẩu).'
    }
  }

  // 1 mail chỉ 1 profile (mọi nhóm)
  const conflict = db.findProfileByGmailEmail(gmail!.email)
  if (conflict && conflict.id !== profileId) {
    return {
      profileId,
      success: false,
      error: `[BỎ QUA] Email ${gmail!.email} đã gắn hồ sơ "${conflict.name}" — không đăng nhập lại.`
    }
  }

  const autoLoginGmail =
    options?.autoLoginGmail !== undefined ? Boolean(options.autoLoginGmail) : profile.autoLoginGmail

  return loginLogContext.run(
    { profileId, profileName: profile.name, email: gmail!.email },
    async () => {
  let browser: Browser | null = null
  let detachGuard: (() => void) | null = null
  let keepExtraTabs = false

  try {
    emitLoginProgress('Mở Chrome')
    if (!options?.alreadyLaunched) {
      const launched = await launchProfile(profileId, {
        skipHomepage: true,
        skipAutoLogin: true,
        windowBounds: options?.windowBounds
      })
      if (!launched.success) {
        return { profileId, success: false, error: launched.error || 'Không mở được Chrome' }
      }
    } else if (options?.windowBounds) {
      await applyWindowBounds(profileId, options.windowBounds)
    }

    const port = getDebugPort(profileId)
    if (!port) {
      return { profileId, success: false, error: 'Không có cổng remote debugging của Chrome' }
    }

    const puppeteer = (await import('puppeteer-core')).default
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null
    })
    assertConnectedToPort(browser, port)

    const page = await ensureSinglePage(browser)
    detachGuard = attachSingleTabGuard(browser, page)

    const identity = `[${profile.name}] ${gmail!.email}`
    await tagPageIdentity(page, identity)

    if (options?.windowBounds) {
      await applyWindowBounds(profileId, options.windowBounds)
    }

    await performLogin(page, gmail!, {
      preferExistingSession: Boolean(options?.preferExistingSession),
      mailKind: options?.mailKind === 'new' ? 'new' : 'old'
    })
    await tagPageIdentity(page, identity)
    await ensureSinglePage(browser)

    // Xác nhận chắc chắn đang ở Gmail app trước khi lưu hồ sơ
    if (!isRealGmailAppUrl(page.url())) {
      await ensureRealGmailInbox(page)
    }
    if (!isRealGmailAppUrl(page.url())) {
      throw new Error('Đăng nhập chưa vào được mail.google.com/mail — không lưu hồ sơ.')
    }

    emitLoginProgress('Đăng nhập OK — đã gán mail vào profile', 'success')
    // Gán Gmail ngay khi vào inbox — 2fa.live / post-setup chạy sau, không ảnh hưởng việc đã gắn
    const saved = db.updateProfile(profileId, {
      gmail,
      autoLoginGmail
    })

    await delay(1200)

    // Gỡ guard sớm — tránh nuốt tab Sheet/Script (kể cả listener async còn treo)
    detachGuard?.()
    detachGuard = null
    await delay(300)

    let postSetupNote = ''
    // Ưu tiên options từ UI; fallback file gmail-setup.json (tránh mất flag khi IPC/UI lệch)
    const { loadGmailSetup } = await import('./gmail-list.service')
    const { open2faLiveTab, formatPostSetupSummary, runPostLoginSetup } = await import(
      './gmail-post-setup.service'
    )
    const savedSetup = loadGmailSetup()
    const shouldPostSetup =
      options?.postLoginSetup === true ||
      (options?.postLoginSetup !== false && savedSetup.enabled)
    const avatarPath = (options?.avatarPath ?? savedSetup.avatarPath ?? '').trim()
    const appsScriptPath = (options?.appsScriptPath ?? savedSetup.appsScriptPath ?? '').trim()
    const appsScriptCode = options?.appsScriptCode ?? savedSetup.appsScriptCode ?? ''
    const formFillEnabled =
      options?.formFillEnabled !== undefined
        ? Boolean(options.formFillEnabled)
        : Boolean(savedSetup.formFillEnabled)
    const formTitle = (options?.formTitle ?? savedSetup.formTitle ?? '').trim()
    const formDescription = (options?.formDescription ?? savedSetup.formDescription ?? '').trim()
    const formHeaderPath = (options?.formHeaderPath ?? savedSetup.formHeaderPath ?? '').trim()

    // Ngay sau login OK: mở 2fa.live trước, rồi mới chạy post-setup
    keepExtraTabs = true
    try {
      emitLoginProgress('Mở 2fa.live và lấy mã')
      const twoFaStep = await open2faLiveTab(browser, getGmailColumn3(gmail))
      emitLoginProgress(
        `[${twoFaStep.ok ? 'OK' : 'WARN'} ${twoFaStep.step}] ${twoFaStep.detail}`,
        twoFaStep.ok ? 'success' : 'warn'
      )
      postSetupNote = formatPostSetupSummary([twoFaStep])
    } catch (error) {
      const note = `2fa.live lỗi: ${error instanceof Error ? error.message : 'không xác định'}`
      emitLoginProgress(note, 'warn')
      postSetupNote = note
    }

    if (shouldPostSetup) {
      keepExtraTabs = true
      emitLoginProgress('Bắt đầu post-setup (avatar → Sheet → Form/Publish → Apps Script)')
      try {
        const steps = await runPostLoginSetup(
          browser,
          {
            avatarPath,
            appsScriptPath,
            appsScriptCode,
            totpSecret: resolveTotpSecret(gmail) || profile.gmail?.totpSecret || undefined,
            formFillEnabled,
            formTitle,
            formDescription,
            formHeaderPath: formHeaderPath || undefined
          },
          (step) => {
            emitLoginProgress(
              `[${step.ok ? 'OK' : 'WARN'} ${step.step}] ${step.detail}`,
              step.ok ? 'success' : 'warn'
            )
          }
        )
        postSetupNote = [postSetupNote, formatPostSetupSummary(steps)].filter(Boolean).join(' · ')
      } catch (error) {
        const note =
          error instanceof Error
            ? `Post-setup lỗi: ${error.message}`
            : 'Post-setup lỗi không xác định'
        emitLoginProgress(note, 'warn')
        postSetupNote = [postSetupNote, note].filter(Boolean).join(' · ')
      }
    } else {
      postSetupNote = [
        postSetupNote,
        'Post-setup đang tắt — bật checkbox "Sau khi login thành công" trên trang Gmail.'
      ]
        .filter(Boolean)
        .join(' · ')
    }

    emitLoginProgress('Hoàn tất luồng login', 'success')
    return {
      profileId,
      success: true,
      message: [
        `Đã đăng nhập & lưu hồ sơ: ${saved.gmail?.email ?? gmail!.email}`,
        postSetupNote
      ]
        .filter(Boolean)
        .join(' · ')
    }
  } catch (error) {
    // Mail lỗi / bỏ qua: reset trang login đúng 1 lần rồi giữ tab cho mail kế tiếp
    if (browser) {
      try {
        const page = await ensureSinglePage(browser)
        const shouldResetLogin =
          error instanceof SkipLoginError ||
          (error instanceof Error &&
            (error.message.toLowerCase().includes('robot') ||
              error.message.includes('bỏ qua') ||
              error.message.includes('điện thoại') ||
              error.message.toLowerCase().includes('password was changed') ||
              error.message.includes('mật khẩu đã') ||
              error.message.toLowerCase().includes('2fa') ||
              error.message.includes('không chính xác')))
        if (shouldResetLogin) {
          await resetToLoginPage(page).catch(() => undefined)
        }
      } catch {
        // ignore
      }
    }

    const message = error instanceof Error ? error.message : 'Đăng nhập Gmail thất bại'
    loginDebugLog('login thất bại', {
      email: gmail?.email,
      message,
      skip: error instanceof SkipLoginError
    })
    emitLoginProgress(message, 'error')
    const skipped = error instanceof SkipLoginError || message.toLowerCase().includes('not a robot')
    return {
      profileId,
      success: false,
      error: skipped ? `[BỎ QUA] ${message}` : message
    }
  } finally {
    detachGuard?.()
    if (browser) {
      try {
        // Sau post-setup phải giữ tab Sheet/Script — không đóng
        if (!keepExtraTabs) {
          await ensureSinglePage(browser)
        }
        browser.disconnect()
      } catch {
        // ignore
      }
    }
  }
    }
  )
}

export async function bulkLoginGmail(ids: string[]): Promise<BulkResult> {
  const successIds: string[] = []
  const failed: Array<{ id: string; error: string }> = []

  for (const id of ids) {
    const result = await loginGmailForProfile(id)
    if (result.success) successIds.push(id)
    else failed.push({ id, error: result.error ?? 'Lỗi' })
  }

  return { successIds, failed }
}
