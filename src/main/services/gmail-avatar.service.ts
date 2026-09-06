/**
 * Đổi ảnh đại diện Google.
 *
 * Entry: Personal info → mở Profile picture theo UI Google.
 * Không chủ động goto /acl; nếu Google điều hướng tới đó thì Ở LẠI và thao tác
 * (trước đây thoát /acl ngay → phá dialog, không upload được).
 * Chỉ thoát /capture (camera trắng).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, extname, isAbsolute, join, resolve } from 'path'
import type { Browser, ElementHandle, Frame, Page } from 'puppeteer-core'
import { getDebugScreenshotsDir } from '../utils/paths'

const PERSONAL_INFO_URL = 'https://myaccount.google.com/personal-info'

const UPLOAD_LABELS = [
  'upload from device',
  'upload from computer',
  'from computer',
  'from your computer',
  'from your device',
  'select a file from your device',
  'select a photo from your device',
  'choose a file from your device',
  'upload a photo',
  'upload photo',
  'upload photos',
  'browse files',
  'tải lên từ thiết bị',
  'tải lên từ máy tính',
  'từ máy tính',
  'từ thiết bị',
  'chọn tệp từ thiết bị',
  'chọn ảnh từ thiết bị',
  'tải ảnh lên'
]

const CHANGE_PHOTO_LABELS = [
  'change profile picture',
  'edit profile picture',
  'add profile picture',
  'update profile picture',
  'change photo',
  'thay đổi ảnh hồ sơ',
  'chỉnh sửa ảnh hồ sơ',
  'thêm ảnh hồ sơ',
  'cập nhật ảnh hồ sơ',
  'đổi ảnh'
]

const PROFILE_ROW_LABELS = [
  'profile picture',
  'profile photo',
  'ảnh hồ sơ',
  'ảnh đại diện'
]

const SAVE_AS_PROFILE_LABELS = [
  'save as profile picture',
  'set as profile picture',
  'set as profile photo',
  'save as profile photo',
  'đặt làm ảnh hồ sơ',
  'lưu làm ảnh hồ sơ',
  'save changes',
  'lưu thay đổi'
]

/** Next trên dialog cắt ảnh — khớp đúng chữ, không dùng "tiếp" (dễ khớp nhầm) */
const CROP_NEXT_LABELS = ['next', 'tiếp theo']

const SAVE_LABELS = [
  ...SAVE_AS_PROFILE_LABELS,
  'apply',
  'áp dụng',
  'accept',
  'chấp nhận',
  'save',
  'lưu',
  'done',
  'xong'
]

const AVOID = [
  'password',
  'mật khẩu',
  'passkey',
  'camera',
  'máy ảnh',
  'webcam',
  'take a photo',
  'take photo',
  'chụp ảnh',
  'capture',
  'delete',
  'xóa',
  'remove',
  'sign out',
  'đăng xuất',
  'who can see',
  'ai có thể xem',
  'anyone',
  'only you',
  'recovery',
  // Tuyệt đối không bấm — hay nằm cạnh Next trên dialog Crop
  'cancel',
  'hủy',
  'huỷ',
  'close',
  'đóng',
  'dismiss',
  'back',
  'quay lại',
  'not now',
  'để sau'
]

export interface AvatarChangeResult {
  step: 'avatar'
  ok: boolean
  detail: string
  screenshotPath?: string
}


function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function framesOf(page: Page): Frame[] {
  try {
    return page.frames()
  } catch {
    return []
  }
}

function isCaptureUrl(url: string): boolean {
  return url.toLowerCase().includes('/profile-picture/capture')
}

function isAclUrl(url: string): boolean {
  const u = url.toLowerCase()
  return u.includes('/profile-picture/acl') || u.includes('/profile-picture/visibility')
}

function isPersonalInfoUrl(url: string): boolean {
  return url.toLowerCase().includes('/personal-info')
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 250
): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true
    await delay(pollMs)
  }
  return false
}

async function pageText(page: Page): Promise<string> {
  const parts: string[] = []
  for (const frame of framesOf(page)) {
    const text = await frame
      .evaluate(() => document.body?.innerText ?? '')
      .catch(() => '')
    if (text) parts.push(text.toLowerCase())
  }
  return parts.join('\n')
}

class AvatarLogger {
  readonly lines: string[] = []
  step(msg: string): void {
    this.lines.push(msg)
  }
  summary(extra?: string): string {
    return [...this.lines, extra].filter(Boolean).join(' · ')
  }
}

async function createPage(browser: Browser): Promise<Page> {
  try {
    const page = await browser.newPage()
    await page.bringToFront().catch(() => undefined)
    return page
  } catch {
    // CDP fallback
  }
  const before = (await browser.pages()).length
  const existing = (await browser.pages())[0]
  if (!existing) throw new Error('Không có tab Chrome')
  const client = await existing.createCDPSession()
  await client.send('Target.createTarget', { url: 'about:blank' })
  const ok = await waitUntil(async () => (await browser.pages()).length > before, 15000, 200)
  if (!ok) throw new Error('Timeout tạo tab')
  const page = (await browser.pages()).at(-1)!
  await page.bringToFront().catch(() => undefined)
  return page
}

async function saveScreenshot(page: Page, tag: string): Promise<string> {
  const dir = getDebugScreenshotsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const safe = tag.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40)
  const filePath = join(dir, `avatar-${Date.now()}-${safe}.png`)
  try {
    writeFileSync(filePath, await page.screenshot({ fullPage: true, type: 'png' }))
    return filePath
  } catch (error) {
    const fallback = join(dir, `avatar-${Date.now()}-${safe}.txt`)
    writeFileSync(
      fallback,
      `${error instanceof Error ? error.message : String(error)}\nURL=${page.url()}`
    )
    return fallback
  }
}

async function dumpDebugState(page: Page, log: AvatarLogger): Promise<void> {
  const frameUrls = framesOf(page).map((f) => f.url())
  const text = (await pageText(page)).slice(0, 500).replace(/\s+/g, ' ')
  log.step(`DEBUG url=${page.url()}`)
  log.step(`DEBUG frames=${frameUrls.length}:${frameUrls.slice(0, 6).join(' | ')}`)
  log.step(`DEBUG text~=${text}`)
}

async function waitPersonalInfoReady(page: Page, timeoutMs = 45000): Promise<boolean> {
  return waitUntil(async () => {
    if (!page.url().toLowerCase().includes('myaccount.google.com')) return false
    if (isCaptureUrl(page.url())) return false
    const text = await pageText(page)
    return (
      text.includes('personal info') ||
      text.includes('thông tin cá nhân') ||
      text.includes('profile picture') ||
      text.includes('ảnh hồ sơ') ||
      text.includes('basic info') ||
      text.includes('thông tin cơ bản')
    )
  }, timeoutMs)
}

async function gotoPersonalInfo(page: Page, log: AvatarLogger, attempt = 1): Promise<void> {
  log.step(`Mở Personal info (#${attempt})`)
  await page.goto(PERSONAL_INFO_URL, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.bringToFront().catch(() => undefined)
  if (!(await waitPersonalInfoReady(page, 45000))) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => undefined)
    if (!(await waitPersonalInfoReady(page, 30000))) {
      throw new Error(`Personal info không tải xong (${page.url()})`)
    }
  }
  log.step('Personal info OK')
}

/** Chỉ thoát trang camera — KHÔNG thoát /acl (đó là chỗ Google mở picker). */
async function escapeCaptureOnly(page: Page, log: AvatarLogger): Promise<void> {
  if (!isCaptureUrl(page.url())) return
  log.step('Kẹt /capture — thử chuyển Upload from device')
  const switched = await clickByLabels(page, UPLOAD_LABELS, 5000)
  if (switched && !isCaptureUrl(page.url())) {
    log.step('Đã thoát capture → upload')
    return
  }
  log.step('Quay Personal info (thoát capture)')
  await gotoPersonalInfo(page, log)
}

async function clickByLabels(
  page: Page,
  labels: string[],
  timeoutMs: number,
  options?: { preferLongest?: boolean; exactOnly?: boolean }
): Promise<boolean> {
  const needles = labels.map((t) => t.toLowerCase())
  const blocked = AVOID.map((t) => t.toLowerCase())
  const preferLongest = options?.preferLongest === true
  const exactOnly = options?.exactOnly === true

  return waitUntil(async () => {
    for (const frame of framesOf(page)) {
      const clicked = await frame
        .evaluate(
          (needlesIn, blockList, preferLong, exact) => {
            const isBlocked = (label: string): boolean => {
              if (blockList.some((b) => label === b || label.startsWith(b + ' ') || label.includes(b))) {
                return true
              }
              return false
            }
            const nodes = Array.from(
              document.querySelectorAll(
                'button, [role="button"], [role="menuitem"], [role="tab"], [role="link"], a, span, div, li, label'
              )
            )
            const candidates: Array<{ el: HTMLElement; score: number }> = []
            for (const node of nodes) {
              const el = node as HTMLElement
              const aria = (el.getAttribute('aria-label') || '').toLowerCase()
              const text = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
              const label = (aria || text.split('\n')[0] || '').trim()
              if (!label || label.length > 90) continue
              if (isBlocked(label)) continue

              const matched = exact
                ? needlesIn.some((n) => label === n)
                : needlesIn.some((n) => label === n || label.startsWith(n) || label.includes(n))
              if (!matched) continue

              const href = (
                (el.closest('a') as HTMLAnchorElement | null)?.href ||
                el.getAttribute('href') ||
                ''
              ).toLowerCase()
              if (href.includes('/capture')) continue

              const style = window.getComputedStyle(el)
              if (style.display === 'none' || style.visibility === 'hidden') continue
              const rect = el.getBoundingClientRect()
              if (rect.width <= 0 || rect.height <= 0) continue

              // Save-as: ưu tiên nhãn dài; Next: ưu tiên nhãn ngắn/chính xác
              let score = preferLong ? label.length * 10 : 1000 - label.length
              if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') score += 50
              if (aria) score += 30
              if (needlesIn.some((n) => label === n)) score += 100
              candidates.push({ el, score })
            }
            if (!candidates.length) return false
            candidates.sort((a, b) => b.score - a.score)
            // Chặn lần cuối trước khi click
            const top = candidates[0]
            const topLabel = (
              top.el.getAttribute('aria-label') ||
              (top.el.innerText || '').split('\n')[0] ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase()
            if (isBlocked(topLabel)) return false
            top.el.click()
            return true
          },
          needles,
          blocked,
          preferLongest,
          exactOnly
        )
        .catch(() => false)
      if (clicked) return true
    }
    return false
  }, timeoutMs, 300)
}

async function hasVisibleLabels(page: Page, labels: string[], exactOnly = false): Promise<boolean> {
  const needles = labels.map((t) => t.toLowerCase())
  for (const frame of framesOf(page)) {
    const hit = await frame
      .evaluate(
        (needlesIn, exact) => {
          const nodes = Array.from(
            document.querySelectorAll('button, [role="button"], [role="menuitem"], a, span, div')
          )
          for (const node of nodes) {
            const el = node as HTMLElement
            const label = (
              el.getAttribute('aria-label') ||
              (el.innerText || '').split('\n')[0] ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase()
            if (!label || label.length > 90) continue
            const ok = exact
              ? needlesIn.some((n) => label === n)
              : needlesIn.some((n) => label === n || label.startsWith(n) || label.includes(n))
            if (!ok) continue
            const style = window.getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden') continue
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) return true
          }
          return false
        },
        needles,
        exactOnly
      )
      .catch(() => false)
    if (hit) return true
  }
  return false
}

async function findFileInputs(page: Page): Promise<ElementHandle<HTMLInputElement>[]> {
  const found: ElementHandle<HTMLInputElement>[] = []
  for (const frame of framesOf(page)) {
    const handles = await frame.$$('input[type="file"]').catch(() => [])
    for (const h of handles) {
      found.push(h as ElementHandle<HTMLInputElement>)
    }
  }
  return found
}

async function waitForFileInput(
  page: Page,
  timeoutMs: number
): Promise<ElementHandle<HTMLInputElement> | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const inputs = await findFileInputs(page)
    if (inputs.length) {
      // dispose extras
      for (const extra of inputs.slice(1)) await extra.dispose().catch(() => undefined)
      return inputs[0]
    }
    await delay(250)
  }
  return null
}

async function hasPickerSignals(page: Page): Promise<boolean> {
  if (isCaptureUrl(page.url())) return false
  const inputs = await findFileInputs(page)
  if (inputs.length) {
    for (const i of inputs) await i.dispose().catch(() => undefined)
    return true
  }
  const text = await pageText(page)
  return (
    UPLOAD_LABELS.some((l) => text.includes(l)) ||
    text.includes('drag a profile photo') ||
    text.includes('kéo ảnh') ||
    text.includes('your photos') ||
    text.includes('ảnh của bạn') ||
    text.includes('save as profile picture') ||
    text.includes('đặt làm ảnh hồ sơ') ||
    CHANGE_PHOTO_LABELS.some((l) => text.includes(l))
  )
}

/**
 * Từ Personal info → mở UI đổi ảnh.
 * Cho phép Google điều hướng (kể cả /acl); chỉ từ chối /capture.
 */
async function openPhotoPicker(page: Page, log: AvatarLogger): Promise<void> {
  if (!isPersonalInfoUrl(page.url())) {
    await gotoPersonalInfo(page, log)
  }

  // 1) Bấm hàng / link Profile picture (đúng UI Google — có thể ra /acl)
  log.step('Bấm Profile picture trên Personal info')
  const rowClicked = await clickByLabels(page, [...CHANGE_PHOTO_LABELS, ...PROFILE_ROW_LABELS], 10000)
  if (!rowClicked) {
    // Fallback: click ảnh lớn nhất (googleusercontent)
    const imgClicked = await page
      .evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[]
        const top = imgs
          .map((img) => {
            const r = img.getBoundingClientRect()
            const src = (img.src || '').toLowerCase()
            const score =
              Math.min(r.width, r.height) +
              (src.includes('googleusercontent') || src.includes('lh3.google') ? 80 : 0)
            return { img, score, area: r.width * r.height }
          })
          .filter((x) => x.area > 40 * 40)
          .sort((a, b) => b.score - a.score)[0]
        if (!top) return false
        const clickable =
          (top.img.closest('a, button, [role="button"]') as HTMLElement | null) || top.img
        clickable.click()
        return true
      })
      .catch(() => false)
    if (!imgClicked) throw new Error('Không tìm thấy Profile picture trên Personal info')
    log.step('Đã bấm ảnh đại diện')
  } else {
    log.step('Đã bấm Profile picture / Change')
  }

  // Chờ UI xuất hiện — kể cả khi URL là /acl
  const ready = await waitUntil(async () => {
    await escapeCaptureOnly(page, log)
    return hasPickerSignals(page)
  }, 20000, 400)

  if (ready) {
    log.step(`Picker sẵn sàng @ ${page.url()}`)
    return
  }

  // Trên /acl: bấm Change để mở dialog — KHÔNG bấm Upload from device ở đây
  // (Upload sẽ gắn file im lặng trong attachImageFile, tránh hiện hộp thoại Windows)
  if (isAclUrl(page.url())) {
    log.step('/acl chưa có upload UI — chờ thêm rồi bấm Change')
    await waitUntil(async () => {
      const text = await pageText(page)
      return text.length > 40 || framesOf(page).length > 1
    }, 12000, 400)

    if (await clickByLabels(page, CHANGE_PHOTO_LABELS, 8000)) {
      log.step('Đã bấm Change trên /acl')
    }
    await escapeCaptureOnly(page, log)

    if (await waitUntil(() => hasPickerSignals(page), 12000, 400)) {
      log.step(`Picker OK sau /acl @ ${page.url()}`)
      return
    }
  }

  // Không bấm Upload from device tại đây — sẽ gắn file thẳng ở bước sau
  if (await hasPickerSignals(page)) {
    log.step(`Picker sẵn sàng @ ${page.url()}`)
    return
  }

  await dumpDebugState(page, log)
  throw new Error(`Không mở được UI upload ảnh (đang ở ${page.url()})`)
}

function mimeOf(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/jpeg'
}

/** Chặn hộp thoại chọn file của OS — Puppeteer/CDP nhận file im lặng */
async function enableSilentFileChooser(page: Page, log: AvatarLogger): Promise<void> {
  try {
    const client = await page.createCDPSession()
    await client.send('Page.setInterceptFileChooserDialog', { enabled: true })
    log.step('Đã bật chặn FileChooser (không hiện ô chọn file Windows)')
  } catch (error) {
    log.step(
      `Không bật CDP FileChooser intercept: ${error instanceof Error ? error.message : 'lỗi'}`
    )
  }
}

async function assignToFileInput(
  input: ElementHandle<HTMLInputElement>,
  absPath: string
): Promise<void> {
  await input.uploadFile(absPath)
  await input
    .evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    .catch(() => undefined)
}

/**
 * Gắn ảnh im lặng — không hiện ô "Open / Load file" của Windows.
 * Ưu tiên input[type=file] ẩn; nếu cần bấm Upload thì bắt FileChooser trước khi click.
 */
async function attachImageFile(
  page: Page,
  absPath: string,
  log: AvatarLogger
): Promise<string> {
  await enableSilentFileChooser(page, log)

  // A) Input ẩn đã có trong DOM → gắn thẳng, không click Upload
  let input = await waitForFileInput(page, 4000)
  if (input) {
    await assignToFileInput(input, absPath)
    await input.dispose()
    log.step('Upload im lặng: input[type=file] (không mở dialog)')
    return 'silent-input'
  }

  // B) Bấm Upload from device NHƯNG đã intercept FileChooser → OS dialog không hiện
  log.step('Bấm Upload from device (FileChooser bị chặn — gắn file thẳng)')
  const chooserPromise = page.waitForFileChooser({ timeout: 15000 }).catch(() => null)
  // Đợi một nhịp để listener sẵn sàng trước click
  await delay(150)
  const clicked = await clickByLabels(page, UPLOAD_LABELS, 8000)
  const chooser = await chooserPromise

  if (chooser) {
    await chooser.accept([absPath])
    log.step('Upload im lặng: FileChooser.accept (không hiện ô Load)')
    return 'silent-chooser'
  }

  // C) Click có thể đã tạo input ẩn thay vì mở chooser
  input = await waitForFileInput(page, 8000)
  if (input) {
    await assignToFileInput(input, absPath)
    await input.dispose()
    log.step('Upload im lặng: input sau click Upload')
    return 'silent-input-after-click'
  }

  if (!clicked) {
    log.step('Không click được Upload from device — thử DataTransfer nếu có input')
  }

  // D) DataTransfer inject (vẫn không cần dialog OS)
  input = await waitForFileInput(page, 2000)
  if (input) {
    const buf = readFileSync(absPath)
    const b64 = buf.toString('base64')
    const name = basename(absPath)
    const mime = mimeOf(absPath)
    await input.evaluate(
      (el, base64, fileName, mimeType) => {
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const file = new File([bytes], fileName, { type: mimeType })
        const dt = new DataTransfer()
        dt.items.add(file)
        ;(el as HTMLInputElement).files = dt.files
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      },
      b64,
      name,
      mime
    )
    await input.dispose()
    log.step('Upload im lặng: DataTransfer')
    return 'silent-datatransfer'
  }

  await dumpDebugState(page, log)
  throw new Error(`Không gắn được file ảnh im lặng (URL: ${page.url()})`)
}

/** True khi Google còn đang upload / xử lý ảnh — chưa được bấm Next/Cancel */
async function isAvatarUploading(page: Page): Promise<boolean> {
  const text = await pageText(page)
  return (
    text.includes('uploading') ||
    text.includes('đang tải') ||
    text.includes('đang tải lên') ||
    text.includes('upload in progress') ||
    text.includes('processing') ||
    text.includes('đang xử lý')
  )
}

/**
 * Trong browser: chọn nút Next thật của dialog Crop & rotate.
 *
 * Nút Google hiện tại:
 *   <span jsname="V67aGc" class="UywwFc-vQzf8d">Next</span>
 * Đây là nhãn chữ bên trong nút Material (UywwFc). Click phải vào nút cha
 * (thường là div/button có class UywwFc / role=button / jsaction), không phải ripple m9ZlFb.
 */
function pickCropNextInPage(allowFallback: boolean, skipTried: boolean): string | null {
  const norm = (s: string | null): string => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()

  const labelOf = (el: Element): string =>
    norm(
      el.getAttribute('aria-label') ||
        el.getAttribute('data-tooltip') ||
        el.getAttribute('title') ||
        (el as HTMLElement).innerText ||
        ''
    )

  const bad = [
    'cancel',
    'hủy',
    'huỷ',
    'close',
    'đóng',
    'back',
    'quay lại',
    'rotate',
    'xoay',
    'zoom',
    'reset'
  ]
  const isBad = (label: string): boolean =>
    bad.some((b) => label === b || label.startsWith(b + ' ') || label.includes(b))

  const isNextLabel = (label: string): boolean =>
    label === 'next' || label === 'tiếp theo' || label === 'tiếp'

  const isVisible = (el: Element): boolean => {
    const s = window.getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  const isDisabled = (el: Element): boolean =>
    el.hasAttribute('disabled') ||
    el.getAttribute('aria-disabled') === 'true' ||
    norm(typeof el.className === 'string' ? el.className : '').includes('disabled')

  // Nhãn V67aGc / ripple → nút Material UywwFc cha
  const asButton = (el: Element): Element => {
    const material = el.closest(
      '[class*="UywwFc"], button, [role="button"], [jsaction*="click:"], a[jsaction], div[jsaction][tabindex], span[role="button"]'
    )
    if (material) return material
    let node: Element | null = el.parentElement
    for (let depth = 0; depth < 5 && node; depth++) {
      const cn = typeof node.className === 'string' ? node.className : ''
      if (
        node.tagName === 'BUTTON' ||
        node.getAttribute('role') === 'button' ||
        node.hasAttribute('jsaction') ||
        cn.includes('UywwFc')
      ) {
        return node
      }
      node = node.parentElement
    }
    return el.parentElement || el
  }

  const store = window as unknown as { __cmCropNext?: Element; __cmTriedNext?: Element[] }
  if (!store.__cmTriedNext) store.__cmTriedNext = []
  const tried = store.__cmTriedNext

  const mark = (el: Element | null, how: string): string | null => {
    if (!el) return null
    if (!isVisible(el)) return null
    if (isBad(labelOf(el))) return null
    if (isDisabled(el)) return null
    if (skipTried && tried.indexOf(el) !== -1) return null
    store.__cmCropNext = el
    if (skipTried) tried.push(el)
    return `${how}|${labelOf(el) || '(no-label)'}|${el.tagName.toLowerCase()}`
  }

  // 1) Đúng nhãn Next mà user chỉ định: span[jsname=V67aGc].UywwFc-vQzf8d
  const v67Selectors = [
    'span[jsname="V67aGc"].UywwFc-vQzf8d',
    'span.UywwFc-vQzf8d[jsname="V67aGc"]',
    'span[jsname="V67aGc"]',
    '.UywwFc-vQzf8d[jsname="V67aGc"]'
  ]
  for (const sel of v67Selectors) {
    for (const labelEl of Array.from(document.querySelectorAll(sel))) {
      const text = norm((labelEl as HTMLElement).innerText || labelEl.textContent)
      // Chỉ nhận đúng chữ Next / Tiếp theo (bỏ Cancel cùng jsname nếu có)
      if (!isNextLabel(text)) continue
      const hit = mark(asButton(labelEl), `V67aGc:${sel}`)
      if (hit) return hit
      const direct = mark(labelEl, `V67aGc-direct:${sel}`)
      if (direct) return direct
    }
  }

  // 2) Mọi span.UywwFc-vQzf8d có chữ Next / Tiếp theo
  for (const labelEl of Array.from(document.querySelectorAll('span.UywwFc-vQzf8d, span[jsname="V67aGc"]'))) {
    const text = norm((labelEl as HTMLElement).innerText || labelEl.textContent)
    if (!isNextLabel(text)) continue
    const hit = mark(asButton(labelEl), 'UywwFc-label-next')
    if (hit) return hit
  }

  // 3) button / role=button / UywwFc có nhãn Next
  for (const el of Array.from(
    document.querySelectorAll('button, [role="button"], [class*="UywwFc"], [jsaction]')
  )) {
    if (!isNextLabel(labelOf(el))) continue
    const hit = mark(el, 'label-next')
    if (hit) return hit
  }

  // 4) Ripple cũ m9ZlFb (UI cũ) → nút cha
  for (const ripple of Array.from(
    document.querySelectorAll('[jsname="m9ZlFb"], span.UTNHae[jsaction*="QBlI0e"]')
  )) {
    const hit = mark(asButton(ripple), 'm9ZlFb-parent')
    if (hit) return hit
  }

  if (!allowFallback) return null

  // 5) Nút chính dưới-phải trong dialog (không phải Cancel)
  const scope =
    document.querySelector('[role="dialog"]') ||
    document.querySelector('[jsname="V68bde"]') ||
    document.body
  const buttons = Array.from(
    scope.querySelectorAll('button, [role="button"], [class*="UywwFc"]')
  ).filter((el) => isVisible(el) && !isBad(labelOf(el)) && !isDisabled(el))
  if (buttons.length) {
    buttons.sort((a, b) => {
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      return rb.bottom + rb.right - (ra.bottom + ra.right)
    })
    const hit = mark(buttons[0], 'primary-bottom-right')
    if (hit) return hit
  }

  return null
}

/** Quên các ứng viên Next đã bấm ở lượt trước */
async function resetTriedCropNext(page: Page): Promise<void> {
  for (const frame of framesOf(page)) {
    await frame
      .evaluate(() => {
        const store = window as unknown as { __cmTriedNext?: Element[] }
        store.__cmTriedNext = []
      })
      .catch(() => undefined)
  }
}

/** Liệt kê nút đang thấy — chỉ để chẩn đoán khi click Next không ăn */
async function dumpCropButtons(page: Page, log: AvatarLogger): Promise<void> {
  for (const frame of framesOf(page)) {
    const list = await frame
      .evaluate(() => {
        const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim()
        return Array.from(
          document.querySelectorAll(
            'button, [role="button"], [class*="UywwFc"], span[jsname="V67aGc"], span.UywwFc-vQzf8d, [jsname]'
          )
        )
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          })
          .slice(0, 30)
          .map((el) => {
            const r = el.getBoundingClientRect()
            const label =
              norm(el.getAttribute('aria-label') || '') ||
              norm((el as HTMLElement).innerText || '').slice(0, 24)
            return `${el.tagName.toLowerCase()}[${el.getAttribute('jsname') || '-'}]"${label}"@${Math.round(r.x)},${Math.round(r.y)}`
          })
      })
      .catch(() => [] as string[])
    if (list.length) log.step(`NÚT(${frame.url().slice(0, 40)}): ${list.join(' ')}`)
  }
}

/**
 * Bấm Next trên Crop & rotate.
 * Ưu tiên span[jsname=V67aGc].UywwFc-vQzf8d ("Next") → nút Material cha.
 */
async function clickGoogleCropNext(page: Page, log: AvatarLogger): Promise<boolean> {
  // Đường tắt: tìm đúng V67aGc "Next" rồi bấm nút cha bằng chuột Puppeteer
  for (const frame of framesOf(page)) {
    const rawHandles = await frame
      .$$('span[jsname="V67aGc"].UywwFc-vQzf8d, span[jsname="V67aGc"]')
      .catch(() => [])
    const handles = rawHandles as ElementHandle<Element>[]

    for (const labelHandle of handles) {
      const meta = await labelHandle
        .evaluate((el: Element) => {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (text !== 'next' && text !== 'tiếp theo' && text !== 'tiếp') {
            return null
          }
          const parent =
            el.closest(
              '[class*="UywwFc"], button, [role="button"], [jsaction], div[tabindex]'
            ) || el.parentElement
          if (!parent) return { mode: 'self' as const, tag: '', cls: '' }
          ;(window as unknown as { __cmCropNext?: Element }).__cmCropNext = parent
          return {
            mode: 'parent' as const,
            tag: parent.tagName.toLowerCase(),
            cls: (typeof parent.className === 'string' ? parent.className : '').slice(0, 60)
          }
        })
        .catch(() => null)

      if (!meta) {
        await labelHandle.dispose().catch(() => undefined)
        continue
      }

      let target: ElementHandle<Element> = labelHandle
      if (meta.mode === 'parent') {
        const parentHandle = await frame
          .evaluateHandle(() => (window as unknown as { __cmCropNext?: Element }).__cmCropNext)
          .catch(() => null)
        const parentEl = parentHandle?.asElement() as ElementHandle<Element> | null
        if (parentEl) {
          await labelHandle.dispose().catch(() => undefined)
          target = parentEl
        } else {
          await parentHandle?.dispose().catch(() => undefined)
        }
      }

      await target.evaluate((el) => {
        ;(el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' })
      }).catch(() => undefined)

      const mouseOk = await target
        .click({ delay: 80 })
        .then(() => true)
        .catch(() => false)

      if (!mouseOk) {
        await target
          .evaluate((el: Element) => {
            const node = el as HTMLElement
            node.focus()
            node.click()
            node.dispatchEvent(
              new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
            )
          })
          .catch(() => undefined)
      }

      await target.dispose().catch(() => undefined)
      log.step(
        `Đã bấm Next (V67aGc→${meta.mode}${meta.mode === 'parent' ? ` ${meta.tag}.${meta.cls}` : ''})`
      )
      return true
    }
  }

  for (const frame of framesOf(page)) {
    const how = await frame.evaluate(pickCropNextInPage, true, true).catch(() => null)
    if (!how) continue

    const handle = await frame
      .evaluateHandle(() => (window as unknown as { __cmCropNext?: Element }).__cmCropNext)
      .catch(() => null)
    const element = handle?.asElement() as ElementHandle<Element> | null
    if (!element) {
      await handle?.dispose().catch(() => undefined)
      continue
    }

    await element.scrollIntoView().catch(() => undefined)

    const mouseOk = await element
      .click({ delay: 60 })
      .then(() => true)
      .catch(() => false)
    if (mouseOk) {
      await element.dispose().catch(() => undefined)
      log.step(`Đã bấm Next Crop bằng chuột (${how})`)
      return true
    }

    const domOk = await element
      .evaluate((el) => {
        const node = el as HTMLElement
        const r = node.getBoundingClientRect()
        const opts: MouseEventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
          buttons: 1
        }
        for (const type of [
          'pointerover',
          'mouseover',
          'pointerdown',
          'mousedown',
          'focus',
          'pointerup',
          'mouseup',
          'click'
        ]) {
          node.dispatchEvent(
            type === 'focus'
              ? new FocusEvent('focus', { bubbles: true })
              : new MouseEvent(type, opts)
          )
        }
        node.click()
        return true
      })
      .catch(() => false)
    await element.dispose().catch(() => undefined)

    if (domOk) {
      log.step(`Đã bấm Next Crop bằng DOM events (${how})`)
      return true
    }
  }

  const keyboardOk = await pressEnterOnCropNext(page, log)
  if (keyboardOk) return true

  if (await clickByLabels(page, CROP_NEXT_LABELS, 3000, { exactOnly: true })) {
    log.step('Đã bấm Next Crop (text exact)')
    return true
  }

  await dumpCropButtons(page, log)
  return false
}

/** Focus nút Next rồi gõ Enter — cứu khi click bị lớp overlay chặn */
async function pressEnterOnCropNext(page: Page, log: AvatarLogger): Promise<boolean> {
  for (const frame of framesOf(page)) {
    const focused = await frame
      .evaluate(() => {
        const el = (window as unknown as { __cmCropNext?: HTMLElement }).__cmCropNext
        if (!el) return false
        el.focus()
        return document.activeElement === el
      })
      .catch(() => false)
    if (!focused) continue

    await page.keyboard.press('Enter').catch(() => undefined)
    log.step('Đã gửi Enter vào nút Next')
    return true
  }
  return false
}

async function hasGoogleCropNext(page: Page): Promise<boolean> {
  for (const frame of framesOf(page)) {
    const found = await frame
      .evaluate(() => {
        const norm = (s: string | null): string => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
        const nodes = Array.from(
          document.querySelectorAll('span[jsname="V67aGc"], span.UywwFc-vQzf8d')
        )
        for (const el of nodes) {
          const text = norm((el as HTMLElement).innerText || el.textContent)
          if (text !== 'next' && text !== 'tiếp theo' && text !== 'tiếp') continue
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) return true
        }
        return false
      })
      .catch(() => false)
    if (found) return true

    const how = await frame.evaluate(pickCropNextInPage, false, false).catch(() => null)
    if (how) return true
  }
  return false
}

async function isCropRotateScreen(page: Page): Promise<boolean> {
  const text = await pageText(page)
  return (
    text.includes('crop & rotate') ||
    text.includes('crop and rotate') ||
    text.includes('cắt và xoay') ||
    text.includes('cắt & xoay') ||
    text.includes('drag to reposition') ||
    text.includes('kéo để định vị') ||
    ((text.includes('crop') || text.includes('cắt')) &&
      (text.includes('rotate') || text.includes('xoay')))
  )
}

async function hasSaveScreen(page: Page): Promise<boolean> {
  return (
    (await hasVisibleLabels(page, SAVE_AS_PROFILE_LABELS, false)) ||
    (await hasVisibleLabels(page, ['save as profile picture', 'đặt làm ảnh hồ sơ'], false))
  )
}

/** Sau khi “bấm Next”, nếu về lại picker upload thì đã trúng Hủy */
async function landedBackOnPicker(page: Page): Promise<boolean> {
  if (await hasSaveScreen(page)) return false
  if (await isCropRotateScreen(page)) return false
  if (await hasGoogleCropNext(page)) return false
  const text = await pageText(page)
  return (
    text.includes('upload from device') ||
    text.includes('from computer') ||
    text.includes('từ thiết bị') ||
    text.includes('từ máy tính') ||
    text.includes('your photos') ||
    text.includes('ảnh của bạn')
  )
}

/**
 * Sau upload: chờ upload xong + Crop & rotate → bấm Next (m9ZlFb) → Save.
 * Không dùng page.mouse (tránh trúng Hủy), không reload giữa chừng.
 */
async function confirmCropAndSave(page: Page, log: AvatarLogger): Promise<void> {
  // 1) Chờ upload xong rồi mới hiện Crop & rotate
  log.step('Chờ upload xong / màn Crop & rotate')
  const cropReady = await waitUntil(async () => {
    if (isCaptureUrl(page.url())) return false
    if (await isAvatarUploading(page)) return false
    if (await hasSaveScreen(page)) return true
    if (await isCropRotateScreen(page)) return true
    return false
  }, 45000, 400)

  if (!cropReady) {
    throw new Error('Đã gắn file nhưng không thấy màn Crop & rotate (hoặc vẫn đang upload)')
  }

  // Đợi nút Next render ổn định — tuyệt đối không bấm gì khi còn Uploading
  await delay(800)
  await waitUntil(
    async () => {
      if (await isAvatarUploading(page)) return false
      return (await hasGoogleCropNext(page)) || (await hasSaveScreen(page))
    },
    20000,
    300
  )

  if (await hasSaveScreen(page)) {
    log.step('Đã ở màn Save — bỏ qua Next')
  } else {
    log.step('Màn Crop & rotate — bấm Next (không bấm Hủy)')
    await resetTriedCropNext(page)
    await dumpCropButtons(page, log)

    let reachedSave = false
    for (let tryNext = 1; tryNext <= 5; tryNext++) {
      if (await isAvatarUploading(page)) {
        log.step(`Thử Next #${tryNext}: vẫn đang upload — chờ`)
        await delay(1000)
        continue
      }

      const clicked = await clickGoogleCropNext(page, log)
      if (!clicked) {
        log.step(`Thử Next #${tryNext}: chưa thấy nút Next`)
        await delay(700)
        continue
      }

      // Nếu trúng Hủy → dialog đóng về picker
      await delay(500)
      if (await landedBackOnPicker(page)) {
        log.step(`Thử Next #${tryNext}: phát hiện đã về picker (có thể trúng Hủy) — dừng click lung tung`)
        throw new Error('Bấm nhầm Hủy/Cancel thay vì Next trên Crop & rotate')
      }

      reachedSave = await waitUntil(async () => {
        if (await hasSaveScreen(page)) return true
        if (!(await hasGoogleCropNext(page)) && (await hasVisibleLabels(page, SAVE_LABELS, false))) {
          return true
        }
        return false
      }, 8000, 350)

      if (reachedSave) {
        log.step(`Sau Next #${tryNext} — đã thấy Save as profile picture`)
        break
      }
      log.step(`Thử Next #${tryNext}: chưa sang Save — bấm lại Next`)
      await delay(600)
    }

    if (!reachedSave) {
      await dumpDebugState(page, log)
      throw new Error('Đã bấm Next trên Crop & rotate nhưng không thấy Save as profile picture')
    }
  }

  // 2) Bấm Save as profile picture (AVOID đã chặn Cancel)
  const saved =
    (await clickByLabels(page, SAVE_AS_PROFILE_LABELS, 12000, { preferLongest: true })) ||
    (await clickByLabels(page, SAVE_LABELS, 6000, { preferLongest: true }))

  if (!saved) throw new Error('Không bấm được nút Save as profile picture')
  log.step('Đã bấm Save as profile picture')

  // 3) Chờ dialog đóng
  await waitUntil(async () => {
    const stillSave = await hasVisibleLabels(page, SAVE_AS_PROFILE_LABELS, false)
    const stillCrop = await isCropRotateScreen(page)
    const stillNext = await hasGoogleCropNext(page)
    return !stillSave && !stillCrop && !stillNext
  }, 20000, 400)
  log.step('Dialog cắt/lưu đã đóng')
}

async function readAvatarSignature(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[]
      const avatar = imgs
        .map((img) => {
          const rect = img.getBoundingClientRect()
          const src = img.src || ''
          const isPhoto = /googleusercontent\.com|lh3\.google/i.test(src)
          return { src, area: rect.width * rect.height, isPhoto }
        })
        .filter((x) => x.isPhoto && x.area > 32 * 32)
        .sort((a, b) => b.area - a.area)[0]
      if (!avatar) return ''
      return avatar.src.split('?')[0].replace(/=[^=/]*$/, '')
    })
    .catch(() => '')
}

export async function changeAvatar(
  browser: Browser,
  avatarPath: string,
  _totpSecret?: string
): Promise<AvatarChangeResult> {
  const log = new AvatarLogger()

  if (!avatarPath.trim()) {
    return { step: 'avatar', ok: false, detail: 'Chưa chọn ảnh đại diện — bỏ qua.' }
  }

  const absPath = isAbsolute(avatarPath) ? avatarPath : resolve(avatarPath)
  if (!existsSync(absPath)) {
    return { step: 'avatar', ok: false, detail: `Không tìm thấy file ảnh: ${absPath}` }
  }
  log.step(`Ảnh: ${absPath}`)

  let page: Page | null = null
  let screenshotPath: string | undefined

  const fail = async (detail: string): Promise<AvatarChangeResult> => {
    if (page) {
      await dumpDebugState(page, log)
      screenshotPath = await saveScreenshot(page, 'fail')
      log.step(`Screenshot: ${screenshotPath}`)
      await page.close().catch(() => undefined)
      page = null
      log.step('Đã đóng tab đổi ảnh')
    }
    return { step: 'avatar', ok: false, detail: log.summary(detail), screenshotPath }
  }

  try {
    page = await createPage(browser)
    const active = page
    await enableSilentFileChooser(active, log)

    await gotoPersonalInfo(active, log)
    const signatureBefore = await readAvatarSignature(active)
    log.step(signatureBefore ? 'Đã ghi chữ ký ảnh cũ' : 'Chưa có ảnh hồ sơ')

    let lastError = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        log.step(`—— Lượt ${attempt} ——`)
        if (!isPersonalInfoUrl(active.url()) && attempt > 1) {
          await gotoPersonalInfo(active, log, attempt)
        } else if (!isPersonalInfoUrl(active.url()) && !isAclUrl(active.url())) {
          await gotoPersonalInfo(active, log, attempt)
        }

        // Lượt 1 có thể đang ở personal-info; lượt 2 reset về personal-info
        if (attempt === 2 || isPersonalInfoUrl(active.url())) {
          if (!isPersonalInfoUrl(active.url())) await gotoPersonalInfo(active, log, attempt)
          await openPhotoPicker(active, log)
        } else {
          // Đang ở trang photo (vd /acl) — tiếp tục upload
          log.step(`Tiếp tục trên ${active.url()}`)
          await escapeCaptureOnly(active, log)
          if (!(await hasPickerSignals(active))) {
            await clickByLabels(active, [...CHANGE_PHOTO_LABELS, ...UPLOAD_LABELS], 8000)
          }
        }

        await escapeCaptureOnly(active, log)

        // Gắn file im lặng — không click Upload trước (tránh hiện ô Load Windows)
        const method = await attachImageFile(active, absPath, log)
        log.step(`Gắn file xong (${method})`)
        // Không bấm gì thêm lúc đang upload — chờ Crop & rotate rồi mới Next
        await delay(500)

        // Quan trọng: chờ upload xong → Next (m9ZlFb) → Save (tuyệt đối không Hủy)
        await confirmCropAndSave(active, log)

        // Chỉ sau khi Save xong mới về Personal info để xác minh
        await gotoPersonalInfo(active, log)
        const verified = await waitUntil(async () => {
          const after = await readAvatarSignature(active)
          if (!after) return false
          if (!signatureBefore) return true
          return after !== signatureBefore
        }, 25000, 600)

        if (!verified) {
          // Không F5/reload (dễ làm mất cảm giác đang làm lại bước cắt ảnh).
          // Chỉ đợi thêm rồi đọc lại chữ ký.
          await delay(3000)
          const after2 = await readAvatarSignature(active)
          if (!after2 || after2 === signatureBefore) {
            throw new Error('Save rồi nhưng ảnh trên Personal info chưa đổi')
          }
        }

        log.step('Xác minh OK')
        await active.close().catch(() => undefined)
        page = null
        log.step('Đã đóng tab đổi ảnh')
        return { step: 'avatar', ok: true, detail: log.summary('Thành công') }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        log.step(`Lượt ${attempt} lỗi: ${lastError}`)
        screenshotPath = await saveScreenshot(active, `attempt${attempt}`)
        log.step(`Screenshot: ${screenshotPath}`)
        await gotoPersonalInfo(active, log, attempt + 1).catch(() => undefined)
      }
    }

    return fail(lastError || 'Đổi ảnh thất bại sau 2 lần thử')
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Đổi ảnh thất bại')
  }
}
