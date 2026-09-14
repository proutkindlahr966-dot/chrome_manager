import { clipboard } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { basename, isAbsolute, resolve } from 'path'
import type { Browser, ElementHandle, Frame, Page, Target } from 'puppeteer-core'
import type { FormLinkStyle, GmailLoginOptions } from '../../shared/types'
import { resolveAppsScriptCode } from './gmail-list.service'
import { changeAvatar } from './gmail-avatar.service'
import { createAsyncLock } from './async-lock'

const SHEET_CREATE_URL = 'https://docs.google.com/spreadsheets/u/0/create'
const FORM_CREATE_URL =
  'https://docs.google.com/forms/u/0/create?usp=forms_home&ths=true'
/** Clipboard OS dùng chung — serialize khi nhiều Chrome paste song song */
const withClipboard = createAsyncLock()

export interface PostSetupStepResult {
  step: 'avatar' | 'sheet' | 'form' | 'script' | '2fa-live'
  ok: boolean
  detail: string
  /** URL Spreadsheet vừa tạo (nếu step=sheet) */
  sheetUrl?: string
  /** URL Form công khai (sau Publish / viewform) */
  formUrl?: string
  /** Mã 6 số lấy từ 2fa.live */
  twoFaCode?: string
}

const LINK_SHEET_TOKEN = '[LINK_SHEET]'
const LINK_FORM_TOKEN = '[LINK_FORM]'

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** Gắn helper cuộn vào viewport — cửa sổ chia ô nhỏ hay cắt nút dưới fold. */
async function installViewportHelpers(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const w = window as Window & {
        __cmReveal?: (el: HTMLElement) => boolean
        __cmToolbarBand?: () => number
      }
      w.__cmReveal = (el: HTMLElement): boolean => {
        try {
          el.scrollIntoView({ block: 'center', inline: 'nearest' })
        } catch {
          // ignore
        }
        let p: HTMLElement | null = el.parentElement
        while (p && p !== document.body) {
          const st = window.getComputedStyle(p)
          const canY =
            /(auto|scroll|overlay)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 8
          const canX =
            /(auto|scroll|overlay)/.test(st.overflowX) && p.scrollWidth > p.clientWidth + 8
          if (canY || canX) {
            const er = el.getBoundingClientRect()
            const pr = p.getBoundingClientRect()
            if (canY) p.scrollTop += er.top + er.height / 2 - (pr.top + pr.height / 2)
            if (canX) p.scrollLeft += er.left + er.width / 2 - (pr.left + pr.width / 2)
          }
          p = p.parentElement
        }
        const r = el.getBoundingClientRect()
        return r.width > 2 && r.height > 2
      }
      w.__cmToolbarBand = (): number => Math.max(180, Math.floor(window.innerHeight * 0.42))
    })
    .catch(() => undefined)
}

/** Chờ URL sheet ổn định dạng /spreadsheets/d/{id}/edit */
async function waitForSpreadsheetUrl(page: Page, timeoutMs = 30000): Promise<string> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const url = page.url()
    const match = url.match(
      /https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+(?:\/edit)?[^#\s]*/i
    )
    if (match) {
      // Chuẩn hóa: bỏ query thừa, giữ /edit nếu có
      const clean = url.split('#')[0]
      const idMatch = clean.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/i)
      if (idMatch) {
        return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/edit`
      }
      return clean
    }
    await delay(400)
  }
  const fallback = page.url()
  if (fallback.includes('/spreadsheets/')) return fallback.split('#')[0]
  throw new Error(`Sheet chưa có URL ổn định (${fallback})`)
}

async function openSpreadsheet(
  browser: Browser
): Promise<PostSetupStepResult & { sheetUrl?: string }> {
  try {
    const page = await openUrlInNewTab(browser, SHEET_CREATE_URL)
    await delay(1500)
    const sheetUrl = await waitForSpreadsheetUrl(page, 35000)
    await page.waitForSelector('#docs-menubar', { timeout: 20000 }).catch(() => null)
    return {
      step: 'sheet',
      ok: true,
      detail: `Đã mở Spreadsheet: ${sheetUrl}`,
      sheetUrl
    }
  } catch (error) {
    return {
      step: 'sheet',
      ok: false,
      detail: error instanceof Error ? error.message : 'Mở Spreadsheet thất bại'
    }
  }
}

async function waitForFormUrl(page: Page, timeoutMs = 30000): Promise<string> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const url = page.url().split('#')[0]
    const idMatch = url.match(/\/forms\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/i)
    if (idMatch) {
      return `https://docs.google.com/forms/d/${idMatch[1]}/edit`
    }
    await delay(400)
  }
  const fallback = page.url().split('#')[0]
  if (fallback.includes('/forms/')) return fallback
  throw new Error(`Form chưa có URL ổn định (${fallback})`)
}

/** Từ URL edit → link trả lời dài (viewform) */
function editUrlToViewform(editUrl: string): string | null {
  const withE = editUrl.match(/\/forms\/d\/e\/([a-zA-Z0-9_-]+)/i)
  if (withE?.[1]) {
    return `https://docs.google.com/forms/d/e/${withE[1]}/viewform`
  }
  const m = editUrl.match(/\/forms\/d\/([a-zA-Z0-9_-]+)/i)
  if (!m?.[1]) return null
  return `https://docs.google.com/forms/d/${m[1]}/viewform`
}

/** Link [LINK_FORM] tối thiểu từ URL /edit — dùng khi Publish/Copy fail hoặc Form crash giữa chừng */
function formResponderUrlFromEdit(editUrl: string): string | undefined {
  const cleaned = (editUrl || '').split('#')[0].trim()
  if (!cleaned || !/docs\.google\.com\/forms\//i.test(cleaned)) return undefined
  const view = editUrlToViewform(cleaned)
  if (view) return view
  const replaced = cleaned.replace(/\/edit.*$/i, '/viewform')
  return /\/viewform/i.test(replaced) ? replaced : undefined
}

function isDetachedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /detached frame|execution context was destroyed|cannot find context with specified id|target closed|session closed/i.test(
    msg
  )
}

function isLiveFrame(frame: Frame): boolean {
  try {
    if ((frame as Frame & { detached?: boolean }).detached) return false
    void frame.url()
    return true
  } catch {
    return false
  }
}

/** Chờ editor Form ổn định sau khi /create nhảy sang /edit (iframe cũ hay bị detach) */
async function waitForFormEditorReady(page: Page, timeoutMs = 20000): Promise<boolean> {
  const started = Date.now()
  const probe = () =>
    Boolean(
      document.querySelector(
        '[aria-label="Form title"], [aria-label="Untitled form"], [aria-label="Form description"], [guidedhelpid="publishGH"], [data-action-id="freebird-publish-dialog"], div[contenteditable="true"]'
      )
    )
  while (Date.now() - started < timeoutMs) {
    const onPage = await page.evaluate(probe).catch(() => false)
    if (onPage) return true
    for (const frame of framesOf(page)) {
      try {
        if (await frame.evaluate(probe)) return true
      } catch {
        // frame vừa detach khi navigate — bỏ qua
      }
    }
    await delay(300)
  }
  return false
}

function isShortFormUrl(url: string): boolean {
  return /^https?:\/\/forms\.gle\/[A-Za-z0-9_-]+\/?$/i.test(url.trim().replace(/[.,;)]+$/, ''))
}

function isLongFormUrl(url: string): boolean {
  const u = url.trim()
  return /docs\.google\.com\/forms\//i.test(u) && /viewform|formResponse|\/e\//i.test(u)
}

function looksLikeFormResponderUrl(url: string): boolean {
  const u = url.trim()
  if (!/^https?:\/\//i.test(u)) return false
  return isShortFormUrl(u) || isLongFormUrl(u)
}

function matchesFormLinkStyle(url: string, style: FormLinkStyle): boolean {
  if (style === 'short') return isShortFormUrl(url)
  return isLongFormUrl(url)
}

function cleanFormUrl(url: string): string {
  return url.trim().split(/\s+/)[0].split('#')[0].replace(/[.,;)]+$/, '')
}

type ResponderPanelSnap = {
  open: boolean
  url: string
  shortenChecked: boolean | null
  shortenX: number
  shortenY: number
  copyX: number
  copyY: number
}

/** Đọc popover "Copy responder link" — URL có thể là chữ, không phải input */
async function readResponderPanelSnap(page: Page): Promise<ResponderPanelSnap | null> {
  for (const frame of framesOf(page)) {
    let snap: ResponderPanelSnap | null = null
    try {
      snap = await frame.evaluate(() => {
        const isVisible = (el: HTMLElement): boolean => {
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') return false
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const labelOf = (el: HTMLElement): string =>
          (el.innerText || el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()

        const hint = (t: string): boolean =>
          t.includes('copy responder link') ||
          t.includes('sao chép liên kết người trả lời') ||
          t.includes('shorten url') ||
          t.includes('rút gọn url')

        const roots = Array.from(
          document.querySelectorAll(
            '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]'
          )
        ) as HTMLElement[]

        // Không quét mọi div (Form editor có hàng nghìn node — đơ khi chạy nhiều luồng).
        // Đi từ nhãn "Shorten URL" / "Copy responder link" rồi leo lên container nhỏ.
        const seeds = Array.from(
          document.querySelectorAll(
            'span, label, button, h1, h2, [role="heading"], [role="checkbox"]'
          )
        ) as HTMLElement[]
        for (const el of seeds) {
          const t = (el.innerText || el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
          if (t.length === 0 || t.length > 48) continue
          if (
            t !== 'shorten url' &&
            t !== 'rút gọn url' &&
            t !== 'copy responder link' &&
            t !== 'sao chép liên kết người trả lời' &&
            t !== 'copy'
          ) {
            continue
          }
          let p: HTMLElement | null = el
          for (let i = 0; i < 10 && p; i++) {
            const pt = (p.innerText || '').toLowerCase()
            if (
              pt.length > 0 &&
              pt.length < 900 &&
              (pt.includes('shorten url') || pt.includes('rút gọn url')) &&
              (pt.includes('copy') || pt.includes('sao chép') || /forms\.gle|docs\.google\.com\/forms/.test(pt))
            ) {
              roots.push(p)
              break
            }
            p = p.parentElement
          }
        }

        const ranked = [...new Set(roots)]
          .filter((el) => hint((el.innerText || '').toLowerCase()) && isVisible(el))
          .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
        const panel = ranked[0]
        if (!panel) return null
        try {
          panel.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        } catch {
          // ignore
        }

        const panelText = panel.innerText || ''
        const urls: string[] = []
        const push = (raw: string): void => {
          const t = (raw || '').trim().split(/\s+/)[0].replace(/[.,;)]+$/, '')
          if (/^https?:\/\/forms\.gle\/[A-Za-z0-9_-]+\/?$/i.test(t)) urls.push(t)
          else if (
            /docs\.google\.com\/forms\//i.test(t) &&
            /viewform|formResponse|\/e\//i.test(t)
          ) {
            urls.push(t)
          }
        }
        const fromText =
          panelText.match(
            /https?:\/\/(?:forms\.gle\/[A-Za-z0-9_-]+|docs\.google\.com\/forms\/[^\s]+)/gi
          ) || []
        for (const u of fromText) push(u)
        for (const el of Array.from(
          panel.querySelectorAll('input, textarea, a[href]')
        ) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLAnchorElement>) {
          if ('href' in el && el.href) push(el.href)
          if ('value' in el) push(String(el.value || ''))
        }
        const short = urls.find((u) => /forms\.gle\//i.test(u))
        const url = short || urls[0] || ''

        const shortenNeedles = ['shorten url', 'rút gọn url']
        let shortenChecked: boolean | null = null
        let shortenX = 0
        let shortenY = 0
        const nodes = Array.from(
          panel.querySelectorAll('label, span, div, li, [role="checkbox"]')
        ) as HTMLElement[]
        for (const el of nodes) {
          const own = labelOf(el)
          if (!shortenNeedles.some((n) => own === n)) continue
          const row =
            (el.closest('label, li, div[role="listitem"]') as HTMLElement | null) ||
            (el.parentElement as HTMLElement | null) ||
            el
          const input = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null
          const roleBox = (row.querySelector('[role="checkbox"]') as HTMLElement | null) ||
            (el.getAttribute('role') === 'checkbox' ? el : null)
          if (roleBox?.getAttribute('aria-checked') === 'true' || input?.checked) {
            shortenChecked = true
          } else if (roleBox?.getAttribute('aria-checked') === 'false' || input) {
            shortenChecked = false
          } else {
            shortenChecked = false
          }
          const box =
            (row.querySelector(
              'div.VfPpkd-MPu53c, [role="checkbox"], input[type="checkbox"]'
            ) as HTMLElement | null) || el
          const r = box.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) {
            shortenX = r.left + Math.min(10, r.width / 2)
            shortenY = r.top + r.height / 2
          }
          break
        }

        let copyX = 0
        let copyY = 0
        const buttons = Array.from(
          panel.querySelectorAll('button, div[role="button"], span[role="button"]')
        ) as HTMLElement[]
        const copyBtn = buttons.find((el) => {
          if (!isVisible(el)) return false
          const lab = labelOf(el)
          return lab === 'copy' || lab === 'sao chép' || lab === 'copy link'
        })
        if (copyBtn) {
          try {
            copyBtn.scrollIntoView({ block: 'center', inline: 'nearest' })
          } catch {
            // ignore
          }
          const r = copyBtn.getBoundingClientRect()
          copyX = r.left + r.width / 2
          copyY = r.top + r.height / 2
        }

        return {
          open: true,
          url,
          shortenChecked,
          shortenX,
          shortenY,
          copyX,
          copyY
        }
      })
    } catch {
      continue
    }
    if (snap?.open) return snap
  }
  return null
}

/** forms.gle → docs.google.com/.../viewform (follow redirect) */
async function resolveShortFormToLong(shortUrl: string): Promise<string | null> {
  try {
    const res = await fetch(shortUrl, { method: 'GET', redirect: 'follow' })
    const finalUrl = cleanFormUrl(res.url || '')
    if (isLongFormUrl(finalUrl)) {
      // Giữ viewform sạch (bỏ query tracking nếu có thể)
      const bare = finalUrl.replace(/\?.*$/, '')
      return /\/viewform$/i.test(bare) ? bare : finalUrl
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Bật/tắt checkbox "Shorten URL" trong popover Copy responder link.
 * Chỉ click khi trạng thái chưa đúng — không tick lại (tránh bỏ tick).
 */
async function setShortenUrlCheckbox(page: Page, wantShort: boolean): Promise<boolean> {
  const snap = await readResponderPanelSnap(page)
  if (snap && snap.shortenChecked === wantShort) return true

  if (snap && snap.shortenX > 0 && snap.shortenY > 0) {
    try {
      await page.mouse.click(snap.shortenX, snap.shortenY, { delay: 30 })
    } catch {
      // fallback DOM
    }
    await delay(400)
    const after = await readResponderPanelSnap(page)
    if (after && after.shortenChecked === wantShort) return true
  }

  for (const frame of framesOf(page)) {
    const ok = await frame
      .evaluate((want) => {
        const needles = ['shorten url', 'rút gọn url']
        const isVisible = (el: HTMLElement): boolean => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const nodes = Array.from(
          document.querySelectorAll('label, span, div, [role="checkbox"]')
        ) as HTMLElement[]
        for (const el of nodes) {
          const text = (el.innerText || el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
          if (!needles.some((n) => text === n)) continue
          if (!isVisible(el)) continue
          const row =
            (el.closest('label, li, [role="listitem"]') as HTMLElement | null) || el
          const input = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null
          const roleBox =
            (row.querySelector('[role="checkbox"]') as HTMLElement | null) ||
            (el.getAttribute('role') === 'checkbox' ? el : null)
          const checked =
            roleBox?.getAttribute('aria-checked') === 'true' || Boolean(input?.checked)
          if (checked === want) return true
          const target =
            (row.querySelector(
              'div.VfPpkd-MPu53c, [role="checkbox"], input[type="checkbox"]'
            ) as HTMLElement | null) || el
          target.click()
          return true
        }
        return false
      }, wantShort)
      .catch(() => false)
    if (ok) {
      await delay(400)
      const after = await readResponderPanelSnap(page)
      if (!after) return ok
      return after.shortenChecked === wantShort || after.shortenChecked === null
    }
  }
  return false
}

async function hasCopyResponderLinkDialog(page: Page): Promise<boolean> {
  const snap = await readResponderPanelSnap(page)
  return Boolean(snap?.open)
}

/** Mở popover Copy responder link bằng chip Published trên toolbar (ảnh 3). */
async function openCopyResponderPanel(page: Page): Promise<boolean> {
  if (await hasCopyResponderLinkDialog(page)) return true

  const toolbar = await locateToolbarPublish(page)
  if (toolbar?.kind === 'published') {
    await mouseClickPoint(page, toolbar)
    await delay(700)
    if (await hasCopyResponderLinkDialog(page)) return true
    await clickToolbarPublishDom(page)
    await delay(500)
  }
  return hasCopyResponderLinkDialog(page)
}

async function clickCopyInResponderPanel(page: Page): Promise<boolean> {
  const snap = await readResponderPanelSnap(page)
  if (snap && snap.copyX > 0 && snap.copyY > 0) {
    if (await mouseClickPoint(page, { x: snap.copyX, y: snap.copyY })) return true
  }

  for (const frame of framesOf(page)) {
    const clicked = await frame
      .evaluate(() => {
        const isVisible = (el: HTMLElement) => {
          const r = el.getBoundingClientRect()
          return r.width > 8 && r.height > 8
        }
        const labelOf = (el: HTMLElement) =>
          (el.innerText || el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
        const buttons = Array.from(
          document.querySelectorAll('button, div[role="button"], span[role="button"]')
        ) as HTMLElement[]
        const inResponderPanel = (el: HTMLElement) => {
          let p: HTMLElement | null = el
          for (let i = 0; i < 12 && p; i++) {
            const t = (p.innerText || '').toLowerCase()
            if (
              (t.includes('shorten url') || t.includes('rút gọn url')) &&
              (t.includes('copy') || t.includes('sao chép'))
            ) {
              return true
            }
            p = p.parentElement
          }
          return false
        }
        const copyBtn = buttons.find((el) => {
          if (!isVisible(el)) return false
          const lab = labelOf(el)
          if (lab !== 'copy' && lab !== 'sao chép' && lab !== 'copy link') return false
          return inResponderPanel(el)
        })
        if (!copyBtn) return false
        const target =
          (copyBtn.closest('button, [role="button"]') as HTMLElement | null) || copyBtn
        target.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 })
        )
        target.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 })
        )
        target.click()
        return true
      })
      .catch(() => false)
    if (clicked) return true
  }
  return false
}

/** Bấm Copy trên popover rồi đọc clipboard — không lấy URL từ chữ trên panel. */
async function copyFormLinkViaCopyButton(page: Page): Promise<string> {
  return withClipboard(async () => {
    const sentinel = `__cm_form_copy_${Date.now()}__`
    try {
      clipboard.writeText(sentinel)
    } catch {
      // ignore
    }
    const clicked = await clickCopyInResponderPanel(page)
    if (!clicked) return ''
    const started = Date.now()
    while (Date.now() - started < 5000) {
      try {
        const t = (clipboard.readText() || '').trim()
        if (t && t !== sentinel && looksLikeFormResponderUrl(t)) {
          return cleanFormUrl(t)
        }
      } catch {
        // ignore
      }
      await delay(200)
    }
    try {
      const t = (clipboard.readText() || '').trim()
      return looksLikeFormResponderUrl(t) ? cleanFormUrl(t) : ''
    } catch {
      return ''
    }
  })
}

/**
 * Bước 3 — popover "Copy responder link":
 * long → Copy
 * short → tick Shorten URL, chờ forms.gle sẵn sàng, rồi Copy
 */
async function extractLinkFromCopyResponderDialog(
  page: Page,
  linkStyle: FormLinkStyle
): Promise<{ link: string; note: string } | null> {
  const opened = await openCopyResponderPanel(page)
  if (!opened) return null

  const wantShort = linkStyle === 'short'
  await setShortenUrlCheckbox(page, wantShort)

  if (wantShort) {
    const waitStarted = Date.now()
    while (Date.now() - waitStarted < 12000) {
      const snap = await readResponderPanelSnap(page)
      if (snap?.url && isShortFormUrl(snap.url)) break
      if (snap && snap.shortenChecked === false) {
        await setShortenUrlCheckbox(page, true)
      }
      await delay(400)
    }
  } else {
    await delay(300)
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const fromClip = await copyFormLinkViaCopyButton(page)
    if (fromClip && matchesFormLinkStyle(fromClip, linkStyle)) {
      return {
        link: fromClip,
        note: wantShort ? 'Copy · Shorten URL · forms.gle' : 'Copy · link dài viewform'
      }
    }
    if (wantShort && fromClip && isLongFormUrl(fromClip)) {
      await delay(800)
      continue
    }
    if (!wantShort && fromClip && isShortFormUrl(fromClip)) {
      const resolved = await resolveShortFormToLong(fromClip)
      if (resolved) {
        return { link: resolved, note: 'Copy · forms.gle → resolve long' }
      }
    }
    await delay(600)
  }
  return null
}

type ClickPoint = { x: number; y: number }

async function mouseClickPoint(page: Page, point: ClickPoint | null): Promise<boolean> {
  if (!point || point.x <= 0 || point.y <= 0) return false
  const vp = await page
    .evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    .catch(() => null)
  // Cửa sổ chia ô: toạ độ ngoài viewport sẽ click nhầm / trượt
  if (vp && (point.x >= vp.w - 1 || point.y >= vp.h - 1 || point.x < 1 || point.y < 1)) {
    return false
  }
  try {
    await page.mouse.move(point.x, point.y, { steps: 3 })
    await delay(40)
    await page.mouse.click(point.x, point.y, { delay: 35 })
    return true
  } catch {
    return false
  }
}

/** Đóng panel Theme (nếu đang mở) để không che / cướp click nút Publish trên toolbar */
async function dismissFormThemePanel(page: Page): Promise<void> {
  for (const frame of framesOf(page)) {
    const clicked = await frame
      .evaluate(() => {
        const body = (document.body?.innerText || '').toLowerCase()
        if (!/\btheme\b/.test(body) && !body.includes('chủ đề')) return false
        const w = window as Window & { __cmReveal?: (el: HTMLElement) => boolean }
        const reveal = (el: HTMLElement): void => {
          if (typeof w.__cmReveal === 'function') w.__cmReveal(el)
          else {
            try {
              el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            } catch {
              // ignore
            }
          }
        }
        let themeHead: HTMLElement | null = null
        const headings = Array.from(document.querySelectorAll('h1, h2, div, span')) as HTMLElement[]
        for (const el of headings) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (t !== 'theme' && t !== 'chủ đề' && t !== 'customize theme') continue
          const r = el.getBoundingClientRect()
          if (r.width > 8 && r.height > 6 && r.height < 56) {
            themeHead = el
            break
          }
        }
        const nodes = Array.from(
          document.querySelectorAll('button, div[role="button"], [aria-label]')
        ) as HTMLElement[]
        const band = Math.max(200, Math.floor(window.innerHeight * 0.4))
        for (const el of nodes) {
          const label = (el.getAttribute('aria-label') || el.innerText || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
          if (label !== 'close' && label !== 'đóng') continue
          reveal(el)
          const r = el.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) continue
          if (themeHead) {
            const hr = themeHead.getBoundingClientRect()
            if (Math.abs(r.top - hr.top) < 56 && r.left >= hr.left - 8) {
              el.click()
              return true
            }
          }
          if (r.top < band && r.left > window.innerWidth * 0.32) {
            el.click()
            return true
          }
        }
        return false
      })
      .catch(() => false)
    if (clicked) {
      await delay(400)
      return
    }
  }
  const stillOpen = await page
    .evaluate(() => {
      if (document.querySelector('.UBrD9d, .zY7l6d, [role="listitem"][data-color]')) return true
      const text = (document.body?.innerText || '').toLowerCase()
      return /\btext style\b/.test(text) || text.includes('kiểu chữ')
    })
    .catch(() => false)
  if (stillOpen) {
    await page.keyboard.press('Escape').catch(() => undefined)
    await delay(250)
  }
}

/**
 * Bước 1 — nút Publish trên toolbar:
 * [guidedhelpid="publishGH"] hoặc [data-action-id="freebird-publish-dialog"] [role="button"]
 */
async function locateToolbarPublish(
  page: Page
): Promise<{ kind: 'publish' | 'published'; x: number; y: number } | null> {
  for (const frame of framesOf(page)) {
    const found = await frame
      .evaluate(() => {
        const reveal = (el: HTMLElement): void => {
          const w = window as Window & { __cmReveal?: (el: HTMLElement) => boolean }
          if (typeof w.__cmReveal === 'function') w.__cmReveal(el)
          else {
            try {
              el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            } catch {
              // ignore
            }
          }
        }
        const isVisible = (el: HTMLElement) => {
          reveal(el)
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') return false
          const r = el.getBoundingClientRect()
          return r.width > 8 && r.height > 8
        }
        const kindOf = (el: HTMLElement): 'publish' | 'published' | null => {
          const a = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase()
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (
            a === 'published' ||
            t === 'published' ||
            a === 'đã xuất bản' ||
            t === 'đã xuất bản'
          ) {
            return 'published'
          }
          if (a === 'publish' || t === 'publish' || a === 'xuất bản' || t === 'xuất bản') {
            return 'publish'
          }
          return null
        }
        const pick = (el: HTMLElement, kind: 'publish' | 'published') => {
          const r = el.getBoundingClientRect()
          return { kind, x: r.left + r.width / 2, y: r.top + r.height / 2 }
        }

        const gh = document.querySelector('[guidedhelpid="publishGH"]') as HTMLElement | null
        if (gh && isVisible(gh)) {
          return pick(gh, kindOf(gh) || 'publish')
        }

        const wraps = Array.from(
          document.querySelectorAll('[data-action-id="freebird-publish-dialog"]')
        ) as HTMLElement[]
        for (const wrap of wraps) {
          const buttons = Array.from(wrap.querySelectorAll('[role="button"]')) as HTMLElement[]
          const withText = buttons.find((b) => {
            if (!isVisible(b)) return false
            const text = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
            return (
              text === 'publish' ||
              text === 'xuất bản' ||
              text === 'published' ||
              text === 'đã xuất bản'
            )
          })
          const target = withText || buttons.find(isVisible)
          if (!target) continue
          return pick(target, kindOf(target) || 'publish')
        }

        const nodes = Array.from(
          document.querySelectorAll('button, div[role="button"], span[role="button"]')
        ) as HTMLElement[]
        const hits: Array<{
          kind: 'publish' | 'published'
          x: number
          y: number
          left: number
        }> = []
        for (const el of nodes) {
          if (!isVisible(el)) continue
          if (el.closest('[role="dialog"], [aria-modal="true"], [role="alertdialog"]')) continue
          if (el.closest('[jsname="vdQQuc"][role="button"]')) continue
          const kind = kindOf(el)
          if (!kind) continue
          const r = el.getBoundingClientRect()
          const band =
            typeof (window as Window & { __cmToolbarBand?: () => number }).__cmToolbarBand ===
            'function'
              ? (window as Window & { __cmToolbarBand: () => number }).__cmToolbarBand()
              : Math.max(180, Math.floor(window.innerHeight * 0.42))
          if (r.top > band) continue
          hits.push({
            kind,
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            left: r.left
          })
        }
        if (!hits.length) return null
        hits.sort((a, b) => b.left - a.left)
        return { kind: hits[0].kind, x: hits[0].x, y: hits[0].y }
      })
      .catch(() => null)
    if (found) {
      const abs = await framePointToPage(page, frame, found)
      return { ...found, x: abs.x, y: abs.y }
    }
  }
  return null
}

async function clickToolbarPublishDom(page: Page): Promise<boolean> {
  for (const frame of framesOf(page)) {
    const clicked = await frame
      .evaluate(() => {
        const isVisible = (el: HTMLElement) => {
          const r = el.getBoundingClientRect()
          return r.width > 8 && r.height > 8
        }
        const fireClick = (el: HTMLElement) => {
          el.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 })
          )
          el.dispatchEvent(
            new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 })
          )
          el.click()
        }

        const gh = document.querySelector('[guidedhelpid="publishGH"]') as HTMLElement | null
        if (gh && isVisible(gh)) {
          fireClick(gh)
          return true
        }

        const wrap = document.querySelector(
          '[data-action-id="freebird-publish-dialog"]'
        ) as HTMLElement | null
        if (wrap) {
          const buttons = Array.from(wrap.querySelectorAll('[role="button"]')) as HTMLElement[]
          const withText = buttons.find((b) => {
            if (!isVisible(b)) return false
            const text = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
            return (
              text === 'publish' ||
              text === 'xuất bản' ||
              text === 'published' ||
              text === 'đã xuất bản'
            )
          })
          const target = withText || buttons.find(isVisible)
          if (target) {
            fireClick(target)
            return true
          }
        }
        return false
      })
      .catch(() => false)
    if (clicked) return true
  }
  return false
}

/**
 * Bước 2 — nút Publish trong dialog "Publish form":
 * [role="button"][jsname="vdQQuc"][aria-label="Publish"] (không nằm trong toolbar).
 */
async function locatePublishFormConfirm(page: Page): Promise<ClickPoint | null> {
  for (const frame of framesOf(page)) {
    const found = await frame
      .evaluate(() => {
        const isVisible = (el: HTMLElement) => {
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') return false
          const r = el.getBoundingClientRect()
          return r.width > 8 && r.height > 8
        }
        const isPublish = (el: HTMLElement) => {
          const a = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase()
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
          return a === 'publish' || a === 'xuất bản' || t === 'publish' || t === 'xuất bản'
        }
        const isToolbar = (el: HTMLElement) =>
          Boolean(
            el.closest('[data-action-id="freebird-publish-dialog"]') ||
              el.getAttribute('guidedhelpid') === 'publishGH'
          )
        const pick = (el: HTMLElement) => {
          const r = el.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        }

        const named = Array.from(
          document.querySelectorAll('[role="button"][jsname="vdQQuc"]')
        ) as HTMLElement[]
        for (const el of named) {
          if (!isVisible(el)) continue
          if (isToolbar(el)) continue
          if (!isPublish(el)) continue
          return pick(el)
        }

        const classed = Array.from(
          document.querySelectorAll('[role="button"].QvWxOd, [role="button"].umgaie')
        ) as HTMLElement[]
        for (const el of classed) {
          if (!isVisible(el)) continue
          if (isToolbar(el)) continue
          if (!isPublish(el)) continue
          return pick(el)
        }

        const looksLikeDialog = (root: HTMLElement) => {
          const text = (root.innerText || '').toLowerCase()
          return (
            text.includes('publish form') ||
            text.includes('xuất bản biểu mẫu') ||
            text.includes('anyone with the link') ||
            text.includes('bất kỳ ai có') ||
            text.includes('nobody will be notified') ||
            text.includes('sẽ không có ai được thông báo')
          )
        }
        const roots = Array.from(
          document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="alertdialog"]')
        ) as HTMLElement[]
        for (const root of roots) {
          if (!looksLikeDialog(root)) continue
          const buttons = Array.from(
            root.querySelectorAll('button, div[role="button"], span[role="button"]')
          ) as HTMLElement[]
          const publishBtn = buttons.find((el) => isVisible(el) && isPublish(el) && !isToolbar(el))
          if (publishBtn) return pick(publishBtn)
        }
        return null
      })
      .catch(() => null)
    if (found) {
      return framePointToPage(page, frame, found)
    }
  }
  return null
}

async function clickPublishFormConfirmDom(page: Page): Promise<boolean> {
  for (const frame of framesOf(page)) {
    const clicked = await frame
      .evaluate(() => {
        const isVisible = (el: HTMLElement) => {
          const r = el.getBoundingClientRect()
          return r.width > 8 && r.height > 8
        }
        const isPublish = (el: HTMLElement) => {
          const a = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase()
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
          return a === 'publish' || a === 'xuất bản' || t === 'publish' || t === 'xuất bản'
        }
        const isToolbar = (el: HTMLElement) =>
          Boolean(
            el.closest('[data-action-id="freebird-publish-dialog"]') ||
              el.getAttribute('guidedhelpid') === 'publishGH'
          )
        const fireClick = (el: HTMLElement) => {
          el.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 })
          )
          el.dispatchEvent(
            new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 })
          )
          el.click()
        }

        const named = Array.from(
          document.querySelectorAll('[role="button"][jsname="vdQQuc"]')
        ) as HTMLElement[]
        for (const el of named) {
          if (!isVisible(el) || isToolbar(el) || !isPublish(el)) continue
          fireClick(el)
          return true
        }

        const classed = Array.from(
          document.querySelectorAll('[role="button"].QvWxOd, [role="button"].umgaie')
        ) as HTMLElement[]
        for (const el of classed) {
          if (!isVisible(el) || isToolbar(el) || !isPublish(el)) continue
          fireClick(el)
          return true
        }
        return false
      })
      .catch(() => false)
    if (clicked) return true
  }
  return false
}

/**
 * Bước 1: bấm Publish trên toolbar
 * Bước 2: bấm Publish trong dialog "Publish form"
 * Sau đó chờ popover Copy responder link (bước 3).
 */
async function publishFormViaToolbarDialog(page: Page): Promise<'ok' | 'skip'> {
  await installViewportHelpers(page)
  await dismissFormThemePanel(page)

  if (await hasCopyResponderLinkDialog(page)) return 'ok'

  const toolbar = await locateToolbarPublish(page)

  // Form đã Published: bấm chip trên toolbar để mở Copy responder link
  if (toolbar?.kind === 'published') {
    await mouseClickPoint(page, toolbar)
    await delay(600)
    if (!(await hasCopyResponderLinkDialog(page))) {
      await clickToolbarPublishDom(page)
      await delay(500)
    }
    const alreadyWait = Date.now()
    while (Date.now() - alreadyWait < 8000) {
      if (await hasCopyResponderLinkDialog(page)) return 'ok'
      await delay(250)
    }
    return (await hasCopyResponderLinkDialog(page)) ? 'ok' : 'skip'
  }

  // Bước 1: Publish trên toolbar (trừ khi dialog bước 2 đã mở)
  if (!(await locatePublishFormConfirm(page))) {
    if (!toolbar) return 'skip'
    await mouseClickPoint(page, toolbar)
    await delay(700)
    if (!(await locatePublishFormConfirm(page))) {
      await clickToolbarPublishDom(page)
      await delay(500)
    }
  }

  const dialogWait = Date.now()
  let confirmPoint: ClickPoint | null = null
  while (Date.now() - dialogWait < 12000) {
    confirmPoint = await locatePublishFormConfirm(page)
    if (confirmPoint) break
    await delay(250)
  }
  if (!confirmPoint) return 'skip'

  // Bước 2: Publish trong dialog
  await mouseClickPoint(page, confirmPoint)
  await delay(500)
  if (await locatePublishFormConfirm(page)) {
    await clickPublishFormConfirmDom(page)
    await delay(400)
  }

  const panelWait = Date.now()
  while (Date.now() - panelWait < 10000) {
    if (await hasCopyResponderLinkDialog(page)) return 'ok'
    const again = await locateToolbarPublish(page)
    if (again?.kind === 'published') {
      await mouseClickPoint(page, again)
      await delay(600)
      if (await hasCopyResponderLinkDialog(page)) return 'ok'
    }
    await delay(300)
  }
  return (await hasCopyResponderLinkDialog(page)) ? 'ok' : 'skip'
}

/**
 * Publish Form theo 3 bước UI mới, rồi lấy link bằng nút Copy.
 * short → tick Shorten URL rồi Copy (forms.gle)
 * long → Copy (docs.google.com/.../viewform)
 */
async function publishAndGetFormLink(
  page: Page,
  editUrl: string,
  linkStyle: FormLinkStyle = 'short'
): Promise<{ link: string; note: string }> {
  const fallbackLong = editUrlToViewform(editUrl) || editUrl.replace(/\/edit.*$/i, '/viewform')
  const styleLabel = linkStyle === 'short' ? 'ngắn' : 'dài'
  await delay(400)

  await publishFormViaToolbarDialog(page)

  const fromCopy = await extractLinkFromCopyResponderDialog(page, linkStyle)
  if (fromCopy) {
    await page.keyboard.press('Escape').catch(() => undefined)
    return fromCopy
  }

  await page.keyboard.press('Escape').catch(() => undefined)
  return {
    link: cleanFormUrl(fallbackLong),
    note: `không Copy được link ${styleLabel} · fallback viewform`
  }
}

/** Điền 1 ô contenteditable / textarea trên Google Forms editor */
async function fillFormEditable(
  page: Page,
  selectors: string[],
  value: string
): Promise<boolean> {
  const text = value.trim()
  if (!text) return false

  for (const selector of selectors) {
    const handle = await page.$(selector).catch(() => null)
    if (!handle) continue

    try {
      const viaDom = await page.evaluate(
        (sel, expected) => {
          const el = document.querySelector(sel) as HTMLElement | null
          if (!el) return false
          const w = window as Window & { __cmReveal?: (el: HTMLElement) => boolean }
          if (typeof w.__cmReveal === 'function') w.__cmReveal(el)
          else {
            try {
              el.scrollIntoView({ block: 'center', inline: 'nearest' })
            } catch {
              // ignore
            }
          }
          el.click()
          el.focus()
          if ('value' in el) {
            const proto = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              'value'
            )
            proto?.set?.call(el, expected)
            ;(el as HTMLTextAreaElement).value = expected
          } else {
            el.textContent = expected
            el.innerText = expected
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: expected }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          el.dispatchEvent(new Event('blur', { bubbles: true }))
          const current = (el.textContent || (el as HTMLTextAreaElement).value || '').trim()
          return current.includes(expected.trim()) || current === expected.trim()
        },
        selector,
        text
      )
      if (viaDom) return true
    } catch {
      // thử selector tiếp
    }
  }
  return false
}

/**
 * Đóng popup onboarding Form (vd. "Familiar and easier access control" → Got it)
 * trước khi xoá câu hỏi / điền tiêu đề.
 */
async function dismissFormOnboardingDialogs(page: Page, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now()
  let dismissed = false
  while (Date.now() - started < timeoutMs) {
    for (const frame of framesOf(page)) {
      let clicked = false
      try {
        clicked = Boolean(
          await frame.evaluate(() => {
          const dialogHints = [
            'familiar and easier access control',
            'responder permissions',
            'drive sharing model',
            'once you\'ve published',
            'once you’ve published',
            'quyền người trả lời',
            'mô hình chia sẻ drive'
          ]
          const btnLabels = [
            'got it',
            'được rồi',
            'đã hiểu',
            'ok',
            'okay',
            'dismiss',
            'đóng',
            'close'
          ]

          const roots = Array.from(
            document.querySelectorAll('[role="dialog"], [aria-modal="true"]')
          ) as HTMLElement[]
          const candidates = roots

          const isVisible = (el: HTMLElement) => {
            const style = window.getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden') return false
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }

          const labelOf = (el: HTMLElement) =>
            (el.innerText || el.getAttribute('aria-label') || '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase()

          for (const root of candidates) {
            const text = (root.innerText || '').toLowerCase()
            if (!dialogHints.some((h) => text.includes(h)) && roots.length === 0) continue
            // Dialog nhỏ kiểu tip: có Got it
            if (
              !dialogHints.some((h) => text.includes(h)) &&
              !btnLabels.some((b) => text.includes(b))
            ) {
              continue
            }

            const buttons = Array.from(
              root.querySelectorAll('button, div[role="button"], span[role="button"], a')
            ) as HTMLElement[]

            const hit = buttons.find((el) => {
              if (!isVisible(el)) return false
              const label = labelOf(el)
              if (!label || label.length > 24) return false
              return btnLabels.some((b) => label === b)
            })
            if (hit) {
              hit.click()
              return true
            }
          }

          // Fallback toàn trang: nút "Got it" hiện rõ
          for (const el of Array.from(
            document.querySelectorAll('button, div[role="button"], span[role="button"]')
          ) as HTMLElement[]) {
            if (!isVisible(el)) continue
            const label = labelOf(el)
            if (label === 'got it' || label === 'đã hiểu' || label === 'được rồi') {
              el.click()
              return true
            }
          }
          return false
        })
        )
      } catch {
        continue
      }

      if (clicked) {
        dismissed = true
        await delay(400)
        // Có thể còn dialog khác — tiếp tục trong vòng lặp
        break
      }
    }

    // Không còn dialog → xong sớm (không lấy chữ "got it" — quá rộng, dễ chờ hết timeout)
    const stillThere = await pageHasText(page, [
      'familiar and easier access control',
      'responder permissions',
      'drive sharing model'
    ]).catch(() => false)
    if (!stillThere) {
      return dismissed
    }
    await delay(300)
  }
  return dismissed
}

async function fillGoogleFormFields(
  page: Page,
  title: string,
  description: string
): Promise<{ titleOk: boolean; descOk: boolean }> {
  // Chờ editor Form sẵn sàng
  const started = Date.now()
  while (Date.now() - started < 25000) {
    const ready = await page
      .evaluate(() => {
        const nodes = document.querySelectorAll(
          '[aria-label="Form title"], [aria-label="Untitled form"], [aria-label="Form description"], [aria-label*="tiêu đề" i], [aria-label*="mô tả" i], div[contenteditable="true"]'
        )
        return nodes.length > 0
      })
      .catch(() => false)
    if (ready) break
    await delay(400)
  }

  let titleOk = await fillFormEditable(
    page,
    [
      '[aria-label="Form title"]',
      '[aria-label="Untitled form"]',
      '[aria-label="Tiêu đề biểu mẫu"]',
      '[aria-label="Biểu mẫu không có tiêu đề"]',
      'textarea[aria-label="Form title"]',
      'div[aria-label="Form title"][contenteditable="true"]',
      'input[aria-label="Form title"]'
    ],
    title
  )

  let descOk = await fillFormEditable(
    page,
    [
      '[aria-label="Form description"]',
      '[aria-label="Mô tả biểu mẫu"]',
      '[aria-label="Description"]',
      '[aria-label="Mô tả"]',
      'textarea[aria-label="Form description"]',
      'div[aria-label="Form description"][contenteditable="true"]',
      'textarea[placeholder*="Form description" i]',
      'div[aria-placeholder*="Form description" i]',
      'div[aria-placeholder*="mô tả" i]'
    ],
    description
  )

  if (description && !descOk) {
    await clickByText(
      page,
      ['form description', 'mô tả biểu mẫu'],
      2500,
      ['theme', 'color', 'header', 'choose']
    )
    descOk = await fillFormEditable(
      page,
      [
        '[aria-label="Form description"]',
        '[aria-label="Mô tả biểu mẫu"]',
        '[aria-label="Description"]',
        'div[contenteditable="true"][aria-label*="description" i]',
        'div[aria-placeholder*="Form description" i]'
      ],
      description
    )
  }

  // Fallback: 2 ô contenteditable đầu trong vùng header Form
  if ((title && !titleOk) || (description && !descOk)) {
    const filled = await page
      .evaluate(
        (payload: { title: string; description: string; needTitle: boolean; needDesc: boolean }) => {
          const editables = Array.from(
            document.querySelectorAll('div[contenteditable="true"], textarea')
          ) as HTMLElement[]
          const visible = editables.filter((el) => {
            const w = window as Window & { __cmReveal?: (el: HTMLElement) => boolean }
            if (typeof w.__cmReveal === 'function') w.__cmReveal(el)
            else {
              try {
                el.scrollIntoView({ block: 'center', inline: 'nearest' })
              } catch {
                // ignore
              }
            }
            const rect = el.getBoundingClientRect()
            return rect.width > 20 && rect.height > 6
          })
          const byLabel = (re: RegExp): HTMLElement | undefined =>
            editables.find((el) =>
              re.test(
                `${el.getAttribute('aria-label') || ''} ${el.getAttribute('aria-placeholder') || ''}`
              )
            )
          const result = { titleOk: !payload.needTitle, descOk: !payload.needDesc }

          const write = (el: HTMLElement, value: string): boolean => {
            if (!value.trim()) return false
            el.focus()
            if ('value' in el) {
              ;(el as HTMLTextAreaElement).value = value
            } else {
              el.textContent = value
              el.innerText = value
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            el.dispatchEvent(new Event('blur', { bubbles: true }))
            const current = (el.textContent || (el as HTMLTextAreaElement).value || '').trim()
            return current.includes(value.trim())
          }

          if (payload.needTitle) {
            const titleEl =
              byLabel(/form title|untitled form|tiêu đề/i) || visible[0]
            if (titleEl) result.titleOk = write(titleEl, payload.title)
          }
          if (payload.needDesc) {
            const descEl =
              byLabel(/form description|mô tả|description/i) ||
              visible.find((el) => el !== byLabel(/form title|untitled form|tiêu đề/i)) ||
              visible[1]
            if (descEl) result.descOk = write(descEl, payload.description)
          }
          return result
        },
        {
          title,
          description,
          needTitle: Boolean(title.trim()) && !titleOk,
          needDesc: Boolean(description.trim()) && !descOk
        }
      )
      .catch(() => null)

    if (filled) {
      if (!titleOk) titleOk = filled.titleOk
      if (!descOk) descOk = filled.descOk
    }
  }

  return { titleOk, descOk }
}

/**
 * Form mới luôn có 1 câu "Untitled Question" / Option 1 — xóa trước khi điền nội dung.
 */
async function deleteDefaultUntitledQuestion(page: Page): Promise<boolean> {
  await page.bringToFront().catch(() => undefined)

  // Chờ card câu hỏi mặc định xuất hiện
  const appeared = await page
    .waitForFunction(
      () => {
        const text = (document.body?.innerText || '').toLowerCase()
        return (
          text.includes('untitled question') ||
          text.includes('câu hỏi không có tiêu đề') ||
          text.includes('option 1') ||
          text.includes('tùy chọn 1')
        )
      },
      { timeout: 12000 }
    )
    .then(() => true)
    .catch(() => false)
  if (!appeared) return false

  await delay(400)

  // 1) Click vào card / ô "Untitled Question" để hiện toolbar
  const selected = await page
    .evaluate(() => {
      const needles = [
        'untitled question',
        'câu hỏi không có tiêu đề',
        'câu hỏi chưa có tiêu đề'
      ]
      const nodes = Array.from(
        document.querySelectorAll(
          '[aria-label], div[contenteditable="true"], textarea, [role="listitem"], [data-item-id]'
        )
      ) as HTMLElement[]

      const isVisible = (el: HTMLElement) => {
        const r = el.getBoundingClientRect()
        return r.width > 20 && r.height > 8
      }

      // Ưu tiên ô tiêu đề câu hỏi
      for (const el of nodes) {
        if (!isVisible(el)) continue
        const label = (
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-placeholder') ||
          el.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        if (!needles.some((n) => label === n || label.includes(n))) continue
        el.click()
        el.focus?.()
        return true
      }

      // Fallback: card chứa Option 1
      const all = Array.from(document.querySelectorAll('div, li, section')) as HTMLElement[]
      const card = all.find((el) => {
        if (!isVisible(el)) return false
        const t = (el.innerText || '').toLowerCase()
        if (t.length > 400) return false
        return (
          (t.includes('untitled question') || t.includes('câu hỏi không có tiêu đề')) &&
          (t.includes('option 1') || t.includes('tùy chọn 1'))
        )
      })
      if (!card) return false
      card.click()
      return true
    })
    .catch(() => false)

  if (!selected) return false
  await delay(500)

  // 2) Bấm Delete trên toolbar câu hỏi (không xóa cả Form)
  const deleted = await page
    .evaluate(() => {
      const avoid = ['form', 'biểu mẫu', 'response', 'phản hồi', 'file', 'tệp']
      const allowExact = new Set(['delete', 'xóa', 'remove', 'gỡ'])
      const allowIncludes = ['delete question', 'delete item', 'xóa câu hỏi', 'xóa mục']

      const nodes = Array.from(
        document.querySelectorAll(
          'button, div[role="button"], span[role="button"], [aria-label]'
        )
      ) as HTMLElement[]

      const candidates: Array<{ el: HTMLElement; score: number }> = []
      for (const el of nodes) {
        const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        if (!label || label.length > 48) continue
        if (avoid.some((a) => label.includes(a))) continue

        const r = el.getBoundingClientRect()
        if (r.width < 8 || r.height < 8) continue

        let score = 0
        if (allowExact.has(label)) score += 10
        if (allowIncludes.some((a) => label.includes(a))) score += 8
        if (label === 'delete' || label === 'xóa') score += 5
        // Icon trash thường chỉ có aria-label Delete
        if (!score) continue
        // Ưu tiên nút gần giữa/dưới viewport (toolbar câu hỏi)
        if (r.top > 80 && r.top < window.innerHeight - 40) score += 2
        candidates.push({ el, score })
      }
      if (!candidates.length) return false
      candidates.sort((a, b) => b.score - a.score)
      candidates[0].el.click()
      return true
    })
    .catch(() => false)

  if (!deleted) {
    // Fallback: Delete key khi đang chọn câu hỏi
    await page.keyboard.press('Delete').catch(() => undefined)
    await delay(300)
  }

  await delay(600)

  // Xác nhận dialog nếu có (Delete / Xóa / OK)
  await clickByText(
    page,
    ['delete', 'xóa', 'ok', 'remove', 'gỡ'],
    2000,
    ['cancel', 'hủy', 'keep', 'giữ']
  ).catch(() => false)

  await delay(500)

  // Thành công nếu không còn Untitled Question (+ Option 1)
  const stillThere = await page
    .evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase()
      return (
        (t.includes('untitled question') || t.includes('câu hỏi không có tiêu đề')) &&
        (t.includes('option 1') || t.includes('tùy chọn 1'))
      )
    })
    .catch(() => true)

  return !stillThere
}

async function enableSilentFileChooser(page: Page): Promise<void> {
  try {
    const client = await page.createCDPSession()
    await client.send('Page.setInterceptFileChooserDialog', { enabled: true })
  } catch {
    // ignore — vẫn thử waitForFileChooser / input.uploadFile
  }
}

/**
 * Khi bấm Browse, Chrome đôi khi mở tab phụ / hiện dialog OS.
 * Chặn FileChooser + đóng tab mới (trừ page đang giữ) để upload im lặng.
 */
function attachBrowseSilenceGuard(
  browser: Browser,
  keepPages: Page[]
): () => void {
  const keep = new Set(keepPages.filter((p) => !p.isClosed()))
  const onTargetCreated = (target: Target): void => {
    if (target.type() !== 'page') return
    void (async () => {
      try {
        const p = await target.page()
        if (!p || p.isClosed() || keep.has(p)) return
        // Đừng đưa tab mới ra trước — đóng luôn nếu blank / helper
        await delay(80)
        if (p.isClosed()) return
        let url = ''
        try {
          url = p.url().toLowerCase()
        } catch {
          return
        }
        const looksHelper =
          !url ||
          url === 'about:blank' ||
          url.startsWith('chrome://') ||
          url.includes('filepicker') ||
          url.includes('blob:') ||
          url.includes('data:')
        if (looksHelper) {
          await p.close().catch(() => undefined)
          return
        }
        // Tab khác: không bringToFront — đóng nếu không phải docs/forms chính
        if (!url.includes('docs.google.com') && !url.includes('forms.google')) {
          await p.close().catch(() => undefined)
        }
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

async function assignFileToInput(input: ElementHandle<HTMLInputElement>, absPath: string): Promise<void> {
  await input.uploadFile(absPath)
  await input
    .evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    .catch(() => undefined)
}

/**
 * Dialog "Select Header": sidebar trái (Themes / Photos / … / Upload).
 * Phải bấm đúng mục Upload — không nhầm tab Themes hay gallery.
 */
async function clickSelectHeaderUpload(page: Page, timeoutMs = 10000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const frame of framesOf(page)) {
      const clicked = await frame
        .evaluate(() => {
          const dialogHints = [
            'select header',
            'chọn tiêu đề',
            'chọn hình ảnh tiêu đề',
            'themes',
            'chủ đề',
            'google drive',
            'google images',
            'by url'
          ]
          const roots = Array.from(
            document.querySelectorAll('[role="dialog"], [aria-modal="true"]')
          ) as HTMLElement[]
          const searchRoots =
            roots.length > 0
              ? roots
              : ([document.body] as HTMLElement[]).filter((el) => {
                  const t = (el.innerText || '').toLowerCase()
                  return dialogHints.some((h) => t.includes(h))
                })

          const isVisible = (el: HTMLElement) => {
            const style = window.getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return false
            }
            const r = el.getBoundingClientRect()
            return r.width > 4 && r.height > 4
          }

          const labelOf = (el: HTMLElement) =>
            (el.innerText || el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase()

          for (const root of searchRoots) {
            const rootText = (root.innerText || '').toLowerCase()
            // Chỉ xử lý khi đang ở picker Select Header (có Themes hoặc Upload trong sidebar)
            if (
              !rootText.includes('select header') &&
              !rootText.includes('themes') &&
              !rootText.includes('chủ đề') &&
              !rootText.includes('upload') &&
              !rootText.includes('tải lên')
            ) {
              continue
            }

            const nodes = Array.from(
              root.querySelectorAll(
                'button, div[role="button"], div[role="tab"], span[role="tab"], [role="option"], [role="menuitem"], [role="listitem"], li, a, div[jsname], span'
              )
            ) as HTMLElement[]

            const candidates: Array<{ el: HTMLElement; score: number; x: number; y: number }> = []
            for (const el of nodes) {
              if (!isVisible(el)) continue
              const label = labelOf(el)
              if (!label || label.length > 48) continue

              // Exact / gần exact Upload — tránh "Themes", "Google Images", category tabs
              const isUpload =
                label === 'upload' ||
                label === 'tải lên' ||
                label === 'uploads' ||
                label === 'upload image' ||
                label === 'upload a file' ||
                label === 'tải tệp lên'
              if (!isUpload) continue

              // Không click nút trong vùng gallery bên phải (thường x lớn)
              const r = el.getBoundingClientRect()
              const rootRect = root.getBoundingClientRect()
              const relX = r.left - rootRect.left
              // Sidebar trái thường < ~280px trong dialog
              if (relX > 320) continue

              let score = 20
              if (label === 'upload' || label === 'tải lên') score += 10
              // Ưu tiên phần dưới sidebar (Upload nằm dưới separator)
              score += Math.min(10, Math.floor(r.top / 80))
              candidates.push({ el, score, x: relX, y: r.top })
            }

            if (!candidates.length) continue
            candidates.sort((a, b) => b.score - a.score || a.x - b.x || b.y - a.y)
            candidates[0].el.click()
            return true
          }
          return false
        })
        .catch(() => false)
      if (clicked) return true
    }
    await delay(350)
  }
  return false
}

/** Chờ panel Upload hiện (browse / drag / input file) — hết Themes gallery */
async function waitForHeaderUploadPanel(page: Page, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const frame of framesOf(page)) {
      const ready = await frame
        .evaluate(() => {
          if (document.querySelectorAll('input[type="file"]').length > 0) return true
          const text = (document.body?.innerText || '').toLowerCase()
          return (
            text.includes('drag a file here') ||
            text.includes('browse') ||
            text.includes('select a file from your device') ||
            text.includes('kéo tệp') ||
            text.includes('duyệt') ||
            text.includes('máy tính của bạn') ||
            text.includes('upload a file') ||
            text.includes('tải tệp') ||
            text.includes('drop files here')
          )
        })
        .catch(() => false)
      if (ready) return true
    }
    await delay(300)
  }
  return false
}

/**
 * Customize theme → Header → Choose image → Upload (sidebar) → Browse → Insert/Done.
 * Trả về mô tả ngắn cho nhật ký.
 */
async function uploadFormHeaderImage(page: Page, imagePath: string): Promise<string> {
  const absPath = isAbsolute(imagePath) ? imagePath : resolve(imagePath)
  if (!existsSync(absPath)) {
    return `header FAIL · không thấy file: ${absPath}`
  }
  const steps: string[] = []
  const note = (s: string): void => {
    steps.push(s)
  }

  await enableSilentFileChooser(page)
  await installViewportHelpers(page)
  await delay(600)

  // Chờ toolbar Form sẵn sàng
  const toolbarReady = await page
    .waitForFunction(
      () => {
        const nodes = Array.from(
          document.querySelectorAll('[aria-label], [data-tooltip], div[role="button"], button')
        )
        return nodes.some((n) => {
          const t = (
            n.getAttribute('aria-label') ||
            n.getAttribute('data-tooltip') ||
            (n as HTMLElement).innerText ||
            ''
          ).toLowerCase()
          return t.includes('theme') || t.includes('giao diện') || t.includes('palette')
        })
      },
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false)
  if (!toolbarReady) note('toolbar chậm')

  // 1) Mở panel Customize theme (palette)
  const openedTheme =
    (await page
      .evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll('div[role="button"], button, span[role="button"], div[aria-label]')
        ) as HTMLElement[]
        const scored = nodes
          .map((el) => {
            const label = (
              el.getAttribute('aria-label') ||
              el.getAttribute('data-tooltip') ||
              el.innerText ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase()
            const rect = el.getBoundingClientRect()
            if (rect.width < 8 || rect.height < 8) return null
            const band =
              typeof (window as Window & { __cmToolbarBand?: () => number }).__cmToolbarBand ===
              'function'
                ? (window as Window & { __cmToolbarBand: () => number }).__cmToolbarBand()
                : Math.max(180, Math.floor(window.innerHeight * 0.42))
            if (rect.top > band) return null // toolbar trên cùng (có thể xuống hàng khi chia ô)
            let score = 0
            if (label === 'customize theme' || label === 'tùy chỉnh giao diện') score += 10
            if (label.includes('customize theme') || label.includes('tùy chỉnh giao diện')) score += 8
            if (label.includes('theme') && label.includes('customize')) score += 6
            if (label.includes('palette')) score += 5
            if (label.includes('giao diện')) score += 4
            if (!score) return null
            return { el, score, label }
          })
          .filter(Boolean) as Array<{ el: HTMLElement; score: number; label: string }>
        scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length)
        if (!scored[0]) return ''
        scored[0].el.click()
        return scored[0].label
      })
      .catch(() => '')) ||
    (await clickByText(
      page,
      ['customize theme', 'tùy chỉnh giao diện', 'tùy chỉnh chủ đề'],
      5000,
      ['header', 'choose image', 'color']
    )
      ? 'clickByText'
      : '')

  if (!openedTheme) return `header FAIL · không mở được Customize theme · ${steps.join(' · ')}`
  note(`theme:${openedTheme}`)
  await delay(1200)

  // 2) Header → Choose image
  const chooseImage =
    (await page
      .evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll('button, div[role="button"], span[role="button"], a')
        ) as HTMLElement[]
        const hit = nodes.find((el) => {
          const t = (el.innerText || el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
          const w = window as Window & { __cmReveal?: (el: HTMLElement) => boolean }
          if (typeof w.__cmReveal === 'function') w.__cmReveal(el)
          else {
            try {
              el.scrollIntoView({ block: 'center', inline: 'nearest' })
            } catch {
              // ignore
            }
          }
          const rect = el.getBoundingClientRect()
          if (rect.width < 12 || rect.height < 8) return false
          return (
            t === 'choose image' ||
            t === 'chọn hình ảnh' ||
            t === 'chọn ảnh' ||
            t.includes('choose image') ||
            t.includes('chọn hình ảnh') ||
            t.includes('replace header') ||
            t.includes('thay hình')
          )
        })
        if (!hit) return false
        hit.click()
        return true
      })
      .catch(() => false)) ||
    (await clickByText(
      page,
      ['choose image', 'chọn hình ảnh', 'chọn ảnh', 'select image', 'replace header', 'thay hình'],
      8000
    ))

  if (!chooseImage) return `header FAIL · không thấy nút Choose image · ${steps.join(' · ')}`
  note('choose-image')
  await delay(1500)

  // Dialog picker đôi khi mở thành cửa sổ/target mới — không bringToFront (tránh lộ tab)
  let pickerPage: Page = page
  try {
    const browser = page.browser()
    const pages = await browser.pages()
    const picker = [...pages]
      .reverse()
      .find((p) => {
        if (p === page || p.isClosed()) return false
        const u = p.url().toLowerCase()
        return (
          u.includes('picker') ||
          u.includes('filepicker') ||
          u.includes('ogb.google') ||
          (u.includes('drive.google.com') && u.includes('picker'))
        )
      })
    if (picker) {
      pickerPage = picker
      note('picker-window')
      await enableSilentFileChooser(pickerPage)
      await installViewportHelpers(pickerPage)
      await delay(400)
    }
  } catch {
    // dùng page hiện tại
  }

  const uploadHost = pickerPage
  await enableSilentFileChooser(uploadHost)
  // Giữ focus ở Form — không nhảy sang tab Browse
  await page.bringToFront().catch(() => undefined)

  const detachBrowseGuard = attachBrowseSilenceGuard(page.browser(), [page, uploadHost])

  try {
  // 3) Select Header → sidebar Upload (không phải Themes gallery)
  let uploadNav = await clickSelectHeaderUpload(uploadHost, 10000)
  if (!uploadNav) {
    // Fallback: clickByText exact-ish, tránh Themes / Photos / Drive
    uploadNav = await clickByText(
      uploadHost,
      ['upload', 'tải lên'],
      5000,
      [
        'themes',
        'chủ đề',
        'photos',
        'ảnh',
        'google drive',
        'google images',
        'by url',
        'work and school',
        'illustrations',
        'birthday',
        'food'
      ]
    )
  }
  if (uploadNav) note('sidebar-upload')
  else note('sidebar-upload-miss')

  const uploadPanel = await waitForHeaderUploadPanel(uploadHost, 9000)
  if (uploadPanel) note('upload-panel')
  else note('upload-panel-miss')
  await delay(500)

  const findFileInputs = async (): Promise<
    Array<{ handle: ElementHandle<HTMLInputElement>; where: string }>
  > => {
    const found: Array<{ handle: ElementHandle<HTMLInputElement>; where: string }> = []
    for (const frame of framesOf(uploadHost)) {
      const inputs = await frame.$$('input[type="file"]')
      for (const input of inputs) {
        found.push({
          handle: input as ElementHandle<HTMLInputElement>,
          where: frame.url().slice(0, 60) || 'main'
        })
      }
    }
    return found
  }

  const tryAssignInputs = async (): Promise<boolean> => {
    const inputs = await findFileInputs()
    for (const item of inputs) {
      try {
        await assignFileToInput(item.handle, absPath)
        note(`input:${item.where}`)
        await item.handle.dispose().catch(() => undefined)
        return true
      } catch {
        await item.handle.dispose().catch(() => undefined)
      }
    }
    return false
  }

  // 4a) Input ẩn đã có sẵn → gắn thẳng, KHÔNG bấm Browse (không mở tab/dialog)
  let attached = await tryAssignInputs()
  if (attached) note('silent-input')

  // 4b) Bấm Browse nhưng FileChooser đã intercept → không hiện hộp thoại / tab OS
  if (!attached) {
    await enableSilentFileChooser(uploadHost)
    const chooserPromise = uploadHost.waitForFileChooser({ timeout: 15000 }).catch(() => null)
    await delay(200)

    const browseClicked = await (async (): Promise<boolean> => {
      for (const frame of framesOf(uploadHost)) {
        const ok = await frame
          .evaluate(() => {
            const nodes = Array.from(
              document.querySelectorAll(
                'button, div[role="button"], span[role="button"], label, a, div[jsname]'
              )
            ) as HTMLElement[]
            const needles = [
              'browse',
              'duyệt',
              'select a file from your device',
              'chọn tệp',
              'máy tính',
              'upload a file',
              'tải tệp lên',
              'computer',
              'drag a file here',
              'kéo tệp'
            ]
            const avoid = ['themes', 'photos', 'google drive', 'google images', 'by url', 'cancel', 'hủy']
            const candidates = nodes
              .map((el) => {
                const t = (el.innerText || el.getAttribute('aria-label') || '')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .toLowerCase()
                const rect = el.getBoundingClientRect()
                if (rect.width < 8 || rect.height < 8) return null
                if (!needles.some((n) => t.includes(n))) return null
                if (avoid.some((a) => t.includes(a))) return null
                return { el, t, len: t.length }
              })
              .filter(Boolean) as Array<{ el: HTMLElement; t: string; len: number }>
            if (!candidates.length) return ''
            candidates.sort((a, b) => a.len - b.len)
            candidates[0].el.click()
            return candidates[0].t
          })
          .catch(() => '')
        if (ok) {
          note(`browse-silent:${ok}`)
          return true
        }
      }
      return clickByText(
        uploadHost,
        [
          'browse',
          'duyệt',
          'select a file from your device',
          'chọn tệp',
          'upload a file',
          'tải tệp',
          'drag a file here'
        ],
        4000,
        ['themes', 'photos', 'cancel', 'hủy']
      )
    })()

    const chooser = await chooserPromise
    if (chooser) {
      await chooser.accept([absPath])
      attached = true
      note('chooser.accept-silent')
    } else if (browseClicked) {
      await delay(800)
      attached = await tryAssignInputs()
      if (!attached) note('browse-no-chooser')
    } else {
      note('no-browse')
    }
    // Luôn kéo focus về Form sau Browse
    await page.bringToFront().catch(() => undefined)
  }

  // 4c) DataTransfer trên mọi input còn lại
  if (!attached) {
    const inputs = await findFileInputs()
    if (inputs.length) {
      const buf = readFileSync(absPath)
      const b64 = buf.toString('base64')
      const name = basename(absPath)
      const ext = name.split('.').pop()?.toLowerCase()
      const mime =
        ext === 'png'
          ? 'image/png'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'gif'
              ? 'image/gif'
              : 'image/jpeg'
      for (const item of inputs) {
        try {
          await item.handle.evaluate(
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
          attached = true
          note('datatransfer')
          await item.handle.dispose().catch(() => undefined)
          break
        } catch {
          await item.handle.dispose().catch(() => undefined)
        }
      }
    } else {
      note('no-file-input')
    }
  }

  if (!attached) {
    // Dump nhãn nút để biết UI đang ở đâu
    const dump = await uploadHost
      .evaluate(() => {
        const labels: string[] = []
        const nodes = Array.from(
          document.querySelectorAll(
            'button, [role="button"], [role="tab"], [role="option"], [role="menuitem"], a, label, div[jsname], li'
          )
        ) as HTMLElement[]
        for (const el of nodes) {
          const t = (el.innerText || el.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
          if (!t || t.length > 60) continue
          const r = el.getBoundingClientRect()
          if (r.width < 4 || r.height < 4) continue
          labels.push(t)
          if (labels.length >= 30) break
        }
        const files = document.querySelectorAll('input[type="file"]').length
        const bodyHint = (document.body?.innerText || '')
          .toLowerCase()
          .includes('select header')
          ? 'select-header'
          : (document.body?.innerText || '').toLowerCase().includes('themes')
            ? 'themes-view'
            : 'other'
        return { labels, files, bodyHint }
      })
      .catch(() => ({ labels: [] as string[], files: 0, bodyHint: '?' }))

    const frameFileCounts: string[] = []
    for (const frame of framesOf(uploadHost)) {
      const n = await frame.$$eval('input[type="file"]', (els) => els.length).catch(() => 0)
      if (n > 0) frameFileCounts.push(`${n}@${frame.url().slice(0, 40)}`)
    }

    return (
      `header FAIL · không gắn được file (${basename(absPath)}) · ${steps.join(' · ')}` +
      ` · view:${dump.bodyHint}` +
      ` · labels:[${dump.labels.slice(0, 15).join(' | ')}]` +
      ` · fileInputs:${dump.files}` +
      (frameFileCounts.length ? ` · frames:${frameFileCounts.join(',')}` : '')
    )
  }

  await delay(1600)
  await installViewportHelpers(uploadHost)
  await uploadHost
    .evaluate(() => {
      const roots = Array.from(
        document.querySelectorAll('[role="dialog"], [role="main"], .picker, body')
      ) as HTMLElement[]
      for (const el of roots) {
        if (el.scrollHeight > el.clientHeight + 16) el.scrollTop = el.scrollHeight
      }
    })
    .catch(() => undefined)
  await delay(400)

  // 5) Crop dialog / Insert / Done / Save — thử nhiều vòng (trên picker + form)
  let confirmed = false
  for (const host of [uploadHost, page]) {
    await installViewportHelpers(host)
    for (let i = 0; i < 5; i++) {
      await host
        .evaluate(() => {
          const roots = Array.from(
            document.querySelectorAll('[role="dialog"], [role="main"], body')
          ) as HTMLElement[]
          for (const el of roots) {
            if (el.scrollHeight > el.clientHeight + 16) el.scrollTop = el.scrollHeight
          }
        })
        .catch(() => undefined)
      const hit = await clickByText(
        host,
        ['insert', 'chèn', 'done', 'xong', 'save', 'lưu', 'select', 'apply', 'áp dụng', 'next', 'tiếp'],
        4000,
        ['cancel', 'hủy', 'close', 'đóng', 'back', 'themes', 'photos']
      )
      if (hit) {
        confirmed = true
        note(`confirm#${i}`)
        await delay(900)
      } else {
        break
      }
    }
    if (confirmed) break
  }

  // Chỉ đóng picker — đừng Escape trang Form (sẽ tắt panel Theme trước bước Color)
  if (uploadHost !== page) {
    await clickByText(uploadHost, ['close', 'đóng'], 1500, ['choose', 'chọn']).catch(() => false)
    await uploadHost.keyboard.press('Escape').catch(() => undefined)
  }

  return confirmed
    ? `header OK · ${basename(absPath)} · ${steps.join(' · ')}`
    : `header WARN · đã upload ${basename(absPath)} (chưa chắc Insert/Done) · ${steps.join(' · ')}`
  } finally {
    detachBrowseGuard()
  }
}

/** Màu theme Form (panel Customize theme → Color, swatch .zY7l6d). */
const FORM_THEME_COLOR = '#0e79f2'
/** Cho phép lệch RGB nhỏ vì Google đôi khi ghi #0b7af5 / rgb() thay vì đúng hex. */
const FORM_THEME_COLOR_MAX_DIST = 28

async function isFormThemePanelOpen(page: Page): Promise<boolean> {
  for (const frame of framesOf(page)) {
    const open = await frame
      .evaluate(() => {
        if (document.querySelector('.UBrD9d, .zY7l6d, [role="listitem"][data-color]')) return true
        const text = (document.body?.innerText || '').toLowerCase()
        return (
          /\btext style\b/.test(text) ||
          text.includes('kiểu chữ') ||
          (text.includes('choose image') && (/\bcolor\b/.test(text) || text.includes('màu')))
        )
      })
      .catch(() => false)
    if (open) return true
  }
  return false
}

async function openFormThemePanel(page: Page): Promise<string> {
  if (await isFormThemePanelOpen(page)) return 'already-open'
  const opened =
    (await page
      .evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll('div[role="button"], button, span[role="button"], div[aria-label]')
        ) as HTMLElement[]
        const scored = nodes
          .map((el) => {
            const label = (
              el.getAttribute('aria-label') ||
              el.getAttribute('data-tooltip') ||
              el.innerText ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase()
            const rect = el.getBoundingClientRect()
            if (rect.width < 8 || rect.height < 8) return null
            const band =
              typeof (window as Window & { __cmToolbarBand?: () => number }).__cmToolbarBand ===
              'function'
                ? (window as Window & { __cmToolbarBand: () => number }).__cmToolbarBand()
                : Math.max(180, Math.floor(window.innerHeight * 0.42))
            if (rect.top > band) return null
            let score = 0
            if (label === 'customize theme' || label === 'tùy chỉnh giao diện') score += 10
            if (label.includes('customize theme') || label.includes('tùy chỉnh giao diện')) score += 8
            if (label.includes('theme') && label.includes('customize')) score += 6
            if (label.includes('palette')) score += 5
            if (label.includes('giao diện')) score += 4
            if (!score) return null
            return { el, score, label }
          })
          .filter(Boolean) as Array<{ el: HTMLElement; score: number; label: string }>
        scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length)
        if (!scored[0]) return ''
        scored[0].el.click()
        return scored[0].label
      })
      .catch(() => '')) ||
    (await clickByText(
      page,
      ['customize theme', 'tùy chỉnh giao diện', 'tùy chỉnh chủ đề'],
      5000,
      ['header', 'choose image', 'color']
    )
      ? 'clickByText'
      : '')
  return opened
}

type ThemeColorPick = { x: number; y: number; matched: string; dist: number }

function hexToRgbTuple(hex: string): [number, number, number] | null {
  const m = hex.trim().toLowerCase().match(/^#([0-9a-f]{6})$/)
  if (!m) return null
  return [
    parseInt(m[1].slice(0, 2), 16),
    parseInt(m[1].slice(2, 4), 16),
    parseInt(m[1].slice(4, 6), 16)
  ]
}

async function scrollFormThemeColorSection(page: Page): Promise<void> {
  for (const frame of framesOf(page)) {
    const ok = await frame
      .evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('div, span, h1, h2, h3, label')) as HTMLElement[]
        for (const el of nodes) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (t !== 'color' && t !== 'màu' && t !== 'màu sắc') continue
          const r = el.getBoundingClientRect()
          if (r.width < 8 || r.height < 6 || r.height > 48) continue
          el.scrollIntoView({ block: 'center', inline: 'nearest' })
          return true
        }
        const swatch = document.querySelector('.UBrD9d, .zY7l6d, [role="listitem"][data-color]') as HTMLElement | null
        if (swatch) {
          swatch.scrollIntoView({ block: 'center', inline: 'nearest' })
          return true
        }
        return false
      })
      .catch(() => false)
    if (ok) return
  }
}

async function pickFormThemeColorSwatch(
  page: Page,
  targetHex: string,
  maxDist: number
): Promise<ThemeColorPick | null> {
  const targetRgb = hexToRgbTuple(targetHex)
  if (!targetRgb) return null
  for (const frame of framesOf(page)) {
    const found = await frame
      .evaluate(
        (wantHex, wantRgb, distLimit) => {
          const parseRgb = (raw: string): [number, number, number] | null => {
            const t = (raw || '').trim().toLowerCase()
            const hex = t.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/)
            if (hex) {
              let h = hex[1]
              if (h.length === 3) h = h.split('').map((c) => c + c).join('')
              return [
                parseInt(h.slice(0, 2), 16),
                parseInt(h.slice(2, 4), 16),
                parseInt(h.slice(4, 6), 16)
              ]
            }
            const rgb = t.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
            if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
            return null
          }
          const toHex = (rgb: [number, number, number]): string =>
            `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`
          const distOf = (rgb: [number, number, number]): number => {
            const dr = rgb[0] - wantRgb[0]
            const dg = rgb[1] - wantRgb[1]
            const db = rgb[2] - wantRgb[2]
            return Math.sqrt(dr * dr + dg * dg + db * db)
          }
          const headingEl = (needles: string[]): HTMLElement | null => {
            const nodes = Array.from(
              document.querySelectorAll('div, span, h1, h2, h3, label')
            ) as HTMLElement[]
            for (const el of nodes) {
              const t = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
              if (!needles.includes(t)) continue
              const r = el.getBoundingClientRect()
              if (r.width > 8 && r.height > 6 && r.height < 48) return el
            }
            return null
          }
          const colorHead = headingEl(['color', 'màu', 'màu sắc'])
          if (colorHead) colorHead.scrollIntoView({ block: 'center', inline: 'nearest' })
          const colorTop = colorHead?.getBoundingClientRect().top ?? 0
          const bgTop = headingEl(['background', 'nền', 'hình nền'])?.getBoundingClientRect().top ?? Infinity

          const items = Array.from(
            document.querySelectorAll(
              'div.UBrD9d, [role="listitem"][data-color], [role="listitem"][aria-label^="#"], div.zY7l6d'
            )
          ) as HTMLElement[]

          type Cand = { el: HTMLElement; matched: string; dist: number; inColor: boolean }
          const cands: Cand[] = []
          const seen = new Set<HTMLElement>()
          for (const el of items) {
            const clickable = el.classList.contains('zY7l6d')
              ? ((el.closest('div.UBrD9d, [role="listitem"]') as HTMLElement | null) || el)
              : el
            if (seen.has(clickable)) continue
            seen.add(clickable)
            const inner = clickable.classList.contains('zY7l6d')
              ? clickable
              : ((clickable.querySelector('.zY7l6d') as HTMLElement | null) ?? clickable)
            const samples = [
              clickable.getAttribute('data-color') || '',
              clickable.getAttribute('data-label') || '',
              clickable.getAttribute('aria-label') || '',
              inner.getAttribute('data-color') || '',
              inner.getAttribute('style') || '',
              inner.style?.backgroundColor || '',
              clickable.getAttribute('style') || '',
              clickable.style?.backgroundColor || ''
            ]
            try {
              samples.push(window.getComputedStyle(inner).backgroundColor)
            } catch {
              // ignore
            }
            let bestDist = Infinity
            let matched = ''
            for (const sample of samples) {
              const rgb = parseRgb(sample)
              if (!rgb) continue
              const d = distOf(rgb)
              if (d < bestDist) {
                bestDist = d
                matched = toHex(rgb)
              }
            }
            if (!Number.isFinite(bestDist) || bestDist > distLimit) continue
            const r = clickable.getBoundingClientRect()
            const inColor =
              (!colorTop || r.top >= colorTop - 12) &&
              (!Number.isFinite(bgTop) || r.top < bgTop - 4)
            cands.push({ el: clickable, matched, dist: bestDist, inColor })
          }
          cands.sort((a, b) => {
            if (a.inColor !== b.inColor) return a.inColor ? -1 : 1
            if (a.matched === wantHex && b.matched !== wantHex) return -1
            if (b.matched === wantHex && a.matched !== wantHex) return 1
            return a.dist - b.dist
          })
          const hit = cands[0]
          if (!hit) return null
          hit.el.scrollIntoView({ block: 'center', inline: 'nearest' })
          const box = hit.el.getBoundingClientRect()
          const inner = (hit.el.querySelector('.zY7l6d') as HTMLElement | null) || hit.el
          const innerBox = inner.getBoundingClientRect()
          const use = innerBox.width >= 8 && innerBox.height >= 8 ? innerBox : box
          return {
            x: use.left + use.width / 2,
            y: use.top + use.height / 2,
            matched: hit.matched,
            dist: Math.round(hit.dist)
          }
        },
        targetHex,
        targetRgb,
        maxDist
      )
      .catch(() => null)
    if (found && found.x > 0 && found.y > 0) return found
  }
  return null
}

async function dumpFormThemeColors(page: Page): Promise<string> {
  for (const frame of framesOf(page)) {
    const dump = await frame
      .evaluate(() => {
        const items = Array.from(
          document.querySelectorAll('div.UBrD9d, [role="listitem"][data-color], div.zY7l6d')
        ) as HTMLElement[]
        const seen = new Set<string>()
        const out: string[] = []
        for (const el of items) {
          const inner = (el.querySelector('.zY7l6d') as HTMLElement | null) || el
          const data = el.getAttribute('data-color') || el.getAttribute('aria-label') || ''
          const bg = inner.getAttribute('style') || inner.style?.backgroundColor || ''
          const key = `${data}|${bg}`.slice(0, 80)
          if (seen.has(key)) continue
          seen.add(key)
          out.push(key)
          if (out.length >= 20) break
        }
        return out.join(' ; ')
      })
      .catch(() => '')
    if (dump) return dump
  }
  return ''
}

async function clickFormThemeColorDom(
  page: Page,
  targetHex: string,
  maxDist: number
): Promise<string> {
  const targetRgb = hexToRgbTuple(targetHex)
  if (!targetRgb) return ''
  for (const frame of framesOf(page)) {
    const matched = await frame
      .evaluate(
        (wantHex, wantRgb, distLimit) => {
          const parseRgb = (raw: string): [number, number, number] | null => {
            const t = (raw || '').trim().toLowerCase()
            const hex = t.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/)
            if (hex) {
              let h = hex[1]
              if (h.length === 3) h = h.split('').map((c) => c + c).join('')
              return [
                parseInt(h.slice(0, 2), 16),
                parseInt(h.slice(2, 4), 16),
                parseInt(h.slice(4, 6), 16)
              ]
            }
            const rgb = t.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
            if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
            return null
          }
          const toHex = (rgb: [number, number, number]): string =>
            `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`
          const distOf = (rgb: [number, number, number]): number => {
            const dr = rgb[0] - wantRgb[0]
            const dg = rgb[1] - wantRgb[1]
            const db = rgb[2] - wantRgb[2]
            return Math.sqrt(dr * dr + dg * dg + db * db)
          }
          const items = Array.from(
            document.querySelectorAll('div.UBrD9d, [role="listitem"][data-color], div.zY7l6d')
          ) as HTMLElement[]
          let best: { el: HTMLElement; matched: string; dist: number } | null = null
          const seen = new Set<HTMLElement>()
          for (const el of items) {
            const clickable = el.classList.contains('zY7l6d')
              ? ((el.closest('div.UBrD9d, [role="listitem"]') as HTMLElement | null) || el)
              : el
            if (seen.has(clickable)) continue
            seen.add(clickable)
            const inner = (clickable.querySelector('.zY7l6d') as HTMLElement | null) || clickable
            const samples = [
              clickable.getAttribute('data-color') || '',
              clickable.getAttribute('aria-label') || '',
              inner.getAttribute('style') || '',
              inner.style?.backgroundColor || ''
            ]
            try {
              samples.push(window.getComputedStyle(inner).backgroundColor)
            } catch {
              // ignore
            }
            let bestDist = Infinity
            let matched = ''
            for (const sample of samples) {
              const rgb = parseRgb(sample)
              if (!rgb) continue
              const d = distOf(rgb)
              if (d < bestDist) {
                bestDist = d
                matched = toHex(rgb)
              }
            }
            if (!Number.isFinite(bestDist) || bestDist > distLimit) continue
            if (!best || bestDist < best.dist || (bestDist === best.dist && matched === wantHex)) {
              best = { el: clickable, matched, dist: bestDist }
            }
          }
          if (!best) return ''
          best.el.scrollIntoView({ block: 'center', inline: 'nearest' })
          const target = (best.el.querySelector('.zY7l6d') as HTMLElement | null) || best.el
          target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
          target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }))
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
          best.el.click()
          return best.matched
        },
        targetHex,
        targetRgb,
        maxDist
      )
      .catch(() => '')
    if (matched) return matched
  }
  return ''
}

/**
 * Customize theme → Color: bấm swatch background-color #0e79f2
 * (div.UBrD9d > div.zY7l6d).
 */
async function selectFormThemeColor(page: Page): Promise<string> {
  await installViewportHelpers(page)
  const opened = await openFormThemePanel(page)
  if (!opened) return 'color FAIL · không mở được Customize theme'
  await delay(700)

  await page
    .waitForFunction(
      () => Boolean(document.querySelector('.UBrD9d, .zY7l6d, [role="listitem"][data-color]')),
      { timeout: 8000 }
    )
    .catch(() => null)

  // Header extract màu mất vài giây; cửa sổ nhỏ phải cuộn mục Color
  let point: ThemeColorPick | null = null
  for (let i = 0; i < 8 && !point; i++) {
    await scrollFormThemeColorSection(page)
    point = await pickFormThemeColorSwatch(page, FORM_THEME_COLOR, FORM_THEME_COLOR_MAX_DIST)
    if (point) break
    await delay(450)
  }

  let note = ''
  if (point) {
    const clicked = await mouseClickPoint(page, point)
    if (clicked) {
      note = `color OK · ${point.matched} · d=${point.dist} · theme:${opened}`
    }
  }

  if (!note) {
    const domMatched = await clickFormThemeColorDom(
      page,
      FORM_THEME_COLOR,
      FORM_THEME_COLOR_MAX_DIST
    )
    if (domMatched) note = `color OK · ${domMatched} · theme:${opened} · dom`
  }

  if (!note) {
    const dump = await dumpFormThemeColors(page)
    note =
      `color FAIL · không thấy swatch ${FORM_THEME_COLOR}` +
      ` · theme:${opened}` +
      (dump ? ` · palette:[${dump}]` : '')
  }

  await delay(300)
  await dismissFormThemePanel(page)
  return note
}

async function openGoogleForm(
  browser: Browser,
  options?: {
    formFillEnabled?: boolean
    formTitle?: string
    formDescription?: string
    formHeaderPath?: string
    formLinkStyle?: FormLinkStyle
  }
): Promise<PostSetupStepResult & { formUrl?: string }> {
  let editUrl = ''
  try {
    const page = await openUrlInNewTab(browser, FORM_CREATE_URL)
    await delay(1500)
    editUrl = await waitForFormUrl(page, 35000).catch(() => page.url().split('#')[0])
    await waitForFormEditorReady(page, 15000)
    await installViewportHelpers(page)

    const fillOn = Boolean(options?.formFillEnabled)
    const title = (options?.formTitle ?? '').trim()
    const description = (options?.formDescription ?? '').trim()
    const headerPath = (options?.formHeaderPath ?? '').trim()
    const linkStyle: FormLinkStyle = options?.formLinkStyle === 'long' ? 'long' : 'short'

    const parts = [`Đã mở Google Form: ${editUrl}`]
    let ok = true
    let formUrl: string | undefined

    const runStep = async (label: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        parts.push(
          isDetachedError(error)
            ? `${label}: detached frame (bỏ qua, tiếp tục)`
            : `${label}: ${msg}`
        )
        ok = false
      }
    }

    await runStep('onboarding', async () => {
      await delay(400)
      const dismissedIntro = await dismissFormOnboardingDialogs(page, 5000)
      parts.push(dismissedIntro ? 'đóng tip Got it' : 'không có tip Got it')
    })

    await runStep('xoá câu hỏi', async () => {
      await delay(400)
      const removedDefault = await deleteDefaultUntitledQuestion(page)
      parts.push(removedDefault ? 'xoá câu hỏi mặc định OK' : 'xoá câu hỏi mặc định FAIL/skip')
    })

    await dismissFormOnboardingDialogs(page, 1500).catch(() => false)

    await runStep('điền', async () => {
      if (fillOn && (title || description)) {
        const { titleOk, descOk } = await fillGoogleFormFields(page, title, description)
        if (title) parts.push(titleOk ? `title OK` : `title FAIL`)
        if (description) parts.push(descOk ? `desc OK` : `desc FAIL`)
        if ((title && !titleOk) || (description && !descOk)) ok = false
      } else if (fillOn) {
        parts.push('điền Form tắt (thiếu tiêu đề/mô tả)')
      }
    })

    await runStep('header', async () => {
      if (!headerPath) return
      await delay(800)
      const headerNote = await uploadFormHeaderImage(page, headerPath)
      parts.push(headerNote)
      if (headerNote.includes('FAIL')) ok = false
    })

    await runStep('color', async () => {
      await delay(600)
      const colorNote = await selectFormThemeColor(page)
      parts.push(colorNote)
      if (colorNote.includes('FAIL')) ok = false
    })

    await runStep('publish', async () => {
      await delay(500)
      const published = await publishAndGetFormLink(page, editUrl, linkStyle)
      parts.push(`link(${linkStyle}): ${published.note} → ${published.link}`)
      formUrl = published.link
    })

    if (!formUrl) {
      formUrl = formResponderUrlFromEdit(editUrl)
      if (formUrl) {
        parts.push(`fallback viewform → ${formUrl}`)
      }
    }

    return {
      step: 'form',
      ok,
      detail: parts.join(' · '),
      formUrl
    }
  } catch (error) {
    const fallback = formResponderUrlFromEdit(editUrl)
    return {
      step: 'form',
      ok: false,
      detail: error instanceof Error ? error.message : 'Mở Google Form thất bại',
      formUrl: fallback
    }
  }
}

/** Thay [LINK_SHEET] / [LINK_FORM] trong code Apps Script */
function injectPlaceholders(
  code: string,
  options?: { sheetUrl?: string; formUrl?: string }
): {
  code: string
  sheetReplaced: number
  formReplaced: number
  missingSheet: boolean
  missingForm: boolean
} {
  let next = code
  const sheetCount = (next.match(/\[LINK_SHEET\]/g) || []).length
  const formCount = (next.match(/\[LINK_FORM\]/g) || []).length
  let missingSheet = false
  let missingForm = false
  let sheetReplaced = 0
  let formReplaced = 0

  if (sheetCount > 0) {
    if (!options?.sheetUrl?.trim()) {
      missingSheet = true
    } else {
      next = next.split(LINK_SHEET_TOKEN).join(options.sheetUrl.trim())
      sheetReplaced = sheetCount
    }
  }

  if (formCount > 0) {
    if (!options?.formUrl?.trim()) {
      missingForm = true
    } else {
      next = next.split(LINK_FORM_TOKEN).join(options.formUrl.trim())
      formReplaced = formCount
    }
  }

  return { code: next, sheetReplaced, formReplaced, missingSheet, missingForm }
}

/** Tạo tab mới ổn định khi connect CDP (fallback Target.createTarget) */
async function createPage(browser: Browser): Promise<Page> {
  try {
    return await browser.newPage()
  } catch {
    // fallback CDP bên dưới
  }

  const beforeCount = (await browser.pages()).length
  const existing = (await browser.pages())[0]
  if (!existing) throw new Error('Không có tab Chrome để tạo tab mới')

  const client = await existing.createCDPSession()
  await client.send('Target.createTarget', { url: 'about:blank' })

  const started = Date.now()
  while (Date.now() - started < 15000) {
    const pages = await browser.pages()
    if (pages.length > beforeCount) {
      return pages[pages.length - 1]
    }
    await delay(200)
  }

  throw new Error('Timeout tạo tab Chrome mới')
}

async function openUrlInNewTab(browser: Browser, url: string): Promise<Page> {
  const page = await createPage(browser)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
  return page
}

const TWO_FA_LIVE_URL = 'https://2fa.live/'

function looksLikeTwoFaCode(value: string): boolean {
  const compact = value.replace(/\s+/g, '')
  if (/^\d{6}$/.test(compact)) return true
  const afterPipe = compact.split('|').pop() || ''
  return /^\d{6}$/.test(afterPipe)
}

/**
 * Sau login: tab mới → 2fa.live → dán cột 3 vào 2FA Secret → Submit → lấy 2FA Code.
 */
export async function open2faLiveTab(
  browser: Browser,
  secret: string
): Promise<PostSetupStepResult> {
  const raw = secret.trim()
  if (!raw) {
    return {
      step: '2fa-live',
      ok: false,
      detail: 'Thiếu dữ liệu cột 3 — không mở 2fa.live'
    }
  }

  try {
    const page = await openUrlInNewTab(browser, TWO_FA_LIVE_URL)
    await page.waitForSelector('textarea', { timeout: 25000 })
    await delay(600)

    const secretBox = await page.$('textarea')
    if (!secretBox) {
      return {
        step: '2fa-live',
        ok: false,
        detail: 'Không thấy ô 2FA Secret trên 2fa.live'
      }
    }

    await secretBox.click({ clickCount: 3 }).catch(() => undefined)
    await page.evaluate((value) => {
      const area = document.querySelector('textarea')
      if (!area) return
      const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      proto?.set?.call(area, value)
      area.value = value
      area.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertFromPaste' }))
      area.dispatchEvent(new Event('change', { bubbles: true }))
    }, raw)
    const shown = await page.evaluate(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value || '')
    if (shown.replace(/\s+/g, '') !== raw.replace(/\s+/g, '')) {
      await secretBox.click({ clickCount: 3 }).catch(() => undefined)
      await page.keyboard.down('Control')
      await page.keyboard.press('KeyA')
      await page.keyboard.up('Control')
      await page.keyboard.press('Backspace')
      await page.keyboard.type(raw, { delay: 5 })
    }

    await delay(200)

    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a'))
      const submit = buttons.find((el) => {
        const label = `${el.textContent || ''} ${(el as HTMLInputElement).value || ''}`.trim()
        return label.toLowerCase() === 'submit'
      })
      if (!submit) return false
      ;(submit as HTMLElement).click()
      return true
    })

    if (!clicked) {
      await page.keyboard.press('Enter').catch(() => undefined)
    }

    const started = Date.now()
    let code = ''
    while (Date.now() - started < 20000) {
      code = await page
        .evaluate(() => {
          const areas = Array.from(document.querySelectorAll('textarea'))
          return (areas[1]?.value || areas[1]?.textContent || '').trim()
        })
        .catch(() => '')
      if (code && looksLikeTwoFaCode(code) && !/abc\|2fa code/i.test(code)) {
        break
      }
      await delay(300)
    }

    const ok = Boolean(code) && looksLikeTwoFaCode(code)
    return {
      step: '2fa-live',
      ok,
      twoFaCode: ok ? code : undefined,
      detail: ok ? `Đã mở 2fa.live · 2FA Code: ${code}` : 'Đã mở 2fa.live nhưng chưa thấy 2FA Code'
    }
  } catch (error) {
    return {
      step: '2fa-live',
      ok: false,
      detail: error instanceof Error ? error.message : 'Mở 2fa.live thất bại'
    }
  }
}

function framesOf(page: Page): Frame[] {
  try {
    return page.frames().filter(isLiveFrame)
  } catch {
    return []
  }
}

/**
 * Click phần tử theo nhãn, quét cả main frame lẫn iframe.
 * - `avoid`: nhãn chứa các từ này thì bỏ qua.
 * - Ưu tiên phần tử có nhãn ngắn nhất → tránh bấm trúng container cha.
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
    for (const frame of framesOf(page)) {
      let clicked = false
      try {
        clicked = Boolean(
          await frame.evaluate(
          (needles, blockList) => {
            const nodes = Array.from(
              document.querySelectorAll(
                'button, a, div[role="button"], span[role="button"], li[role="menuitem"], div[role="menuitem"], input[type="submit"], span.l4V7wb, span.Fxmcue, span.NPEfkd, span.snByac, span[jsslot]'
              )
            )
            const reveal = (el: HTMLElement): boolean => {
              const w = window as Window & { __cmReveal?: (el: HTMLElement) => boolean }
              if (typeof w.__cmReveal === 'function') return w.__cmReveal(el)
              try {
                el.scrollIntoView({ block: 'center', inline: 'nearest' })
              } catch {
                // ignore
              }
              let p: HTMLElement | null = el.parentElement
              while (p && p !== document.body) {
                const st = window.getComputedStyle(p)
                if (/(auto|scroll|overlay)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 8) {
                  const er = el.getBoundingClientRect()
                  const pr = p.getBoundingClientRect()
                  p.scrollTop += er.top + er.height / 2 - (pr.top + pr.height / 2)
                }
                p = p.parentElement
              }
              const r = el.getBoundingClientRect()
              return r.width > 2 && r.height > 2
            }
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
              reveal(el)
              const rect = el.getBoundingClientRect()
              if (rect.width <= 0 || rect.height <= 0) continue
              candidates.push({ el, label })
            }
            if (candidates.length === 0) return false
            candidates.sort((a, b) => a.label.length - b.label.length)
            const el = candidates[0].el
            const target =
              (el.closest(
                'button, a, [role="button"], span.l4V7wb, span.Fxmcue, [jsslot]'
              ) as HTMLElement | null) || el
            target.click()
            return true
          },
          lowered,
          blocked
        )
        )
      } catch {
        continue
      }
      if (clicked) return true
    }
    await delay(300)
  }
  return false
}

async function focusScriptEditor(page: Page): Promise<boolean> {
  const selectors = [
    '.monaco-editor textarea.inputarea',
    '.monaco-editor .native-edit-context',
    '.monaco-editor .inputarea',
    'textarea.inputarea',
    '.ace_text-input',
    '.ace_editor',
    'div[role="textbox"]',
    '.monaco-editor'
  ]
  for (const sel of selectors) {
    const el = await page.$(sel)
    if (!el) continue
    await el.click({ delay: 20 }).catch(() => undefined)
    await page.focus(sel).catch(() => undefined)
    return true
  }

  const box = await page.evaluate(() => {
    const monaco = document.querySelector('.monaco-editor') as HTMLElement | null
    const ace = document.querySelector('.ace_editor') as HTMLElement | null
    const target = monaco || ace
    if (!target) return null
    const r = target.getBoundingClientRect()
    return { x: r.left + Math.min(120, r.width / 2), y: r.top + Math.min(80, r.height / 2) }
  })
  if (box) {
    await page.mouse.click(box.x, box.y)
    return true
  }
  return false
}

async function setEditorContent(page: Page, code: string): Promise<string> {
  const viaApi = await page.evaluate((text) => {
    const w = window as unknown as {
      monaco?: {
        editor?: { getModels: () => Array<{ setValue: (v: string) => void; getValue: () => string }> }
      }
      ace?: {
        edit: (el: Element) => { setValue: (v: string, cursorPos?: number) => void; getValue: () => string }
      }
    }

    try {
      const models = w.monaco?.editor?.getModels?.() ?? []
      if (models.length > 0) {
        models[0].setValue(text)
        return models[0].getValue().length >= Math.min(20, text.length) ? 'monaco-api' : null
      }
    } catch {
      // ignore
    }

    try {
      const aceEl = document.querySelector('.ace_editor')
      if (aceEl && w.ace?.edit) {
        const ed = w.ace.edit(aceEl)
        ed.setValue(text, -1)
        return ed.getValue().length >= Math.min(20, text.length) ? 'ace-api' : null
      }
    } catch {
      // ignore
    }

    return null
  }, code)

  if (viaApi) return viaApi

  return withClipboard(async () => {
    const previous = clipboard.readText()
    try {
      clipboard.writeText(code)
      await page.keyboard.down('Control')
      await page.keyboard.press('KeyA')
      await page.keyboard.up('Control')
      await delay(120)
      await page.keyboard.down('Control')
      await page.keyboard.press('KeyV')
      await page.keyboard.up('Control')
      await delay(500)
      return 'os-clipboard-paste'
    } finally {
      try {
        clipboard.writeText(previous)
      } catch {
        // ignore restore
      }
    }
  })
}

async function readEditorSnippet(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as {
      monaco?: { editor?: { getModels: () => Array<{ getValue: () => string }> } }
      ace?: { edit: (el: Element) => { getValue: () => string } }
    }
    try {
      const models = w.monaco?.editor?.getModels?.() ?? []
      if (models[0]) return models[0].getValue()
    } catch {
      // ignore
    }
    try {
      const aceEl = document.querySelector('.ace_editor')
      if (aceEl && w.ace?.edit) return w.ace.edit(aceEl).getValue()
    } catch {
      // ignore
    }
    const lines = Array.from(document.querySelectorAll('.monaco-editor .view-line'))
      .map((l) => l.textContent || '')
      .join('\n')
    if (lines.trim()) return lines
    return document.querySelector('.ace_content')?.textContent ?? ''
  })
}

async function waitForScriptEditor(page: Page, timeoutMs = 60000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ready = await page.evaluate(() => {
      return Boolean(
        document.querySelector('.monaco-editor') ||
          document.querySelector('.ace_editor') ||
          document.querySelector('textarea.inputarea') ||
          document.querySelector('.native-edit-context')
      )
    })
    if (ready) return true

    const url = page.url().toLowerCase()
    if (url.includes('/edit') || url.includes('macros') || url.includes('script.google.com')) {
      await delay(800)
      continue
    }
    await delay(500)
  }
  return false
}

/** Ctrl+S lưu project Apps Script */
async function saveAppsScript(page: Page): Promise<boolean> {
  await focusScriptEditor(page).catch(() => false)
  await delay(200)
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyS')
  await page.keyboard.up('Control')
  await delay(1500)
  return true
}

/**
 * Bấm Run trên thanh công cụ Apps Script.
 * Tránh bấm nhầm Rename / Project title / Debug.
 */
async function runAppsScript(page: Page): Promise<boolean> {
  // 1) aria-label / title chính xác trên toolbar
  const byAria = await page
    .evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll('button, [role="button"], div[role="button"]')
      ) as HTMLElement[]
      const prefer = ['run', 'chạy']
      const avoid = ['debug', 'gỡ lỗi', 'rename', 'đổi tên', 'save', 'lưu', 'settings', 'cài đặt']
      const hits: Array<{ el: HTMLElement; score: number }> = []
      for (const el of nodes) {
        const label = (
          el.getAttribute('aria-label') ||
          el.getAttribute('data-tooltip') ||
          el.getAttribute('title') ||
          el.innerText ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        if (!label || label.length > 40) continue
        if (avoid.some((a) => label.includes(a))) continue
        if (!prefer.some((p) => label === p || label.startsWith(p + ' '))) continue
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        let score = label === 'run' || label === 'chạy' ? 100 : 50
        if (r.top < 120) score += 40
        hits.push({ el, score })
      }
      if (!hits.length) return false
      hits.sort((a, b) => b.score - a.score)
      hits[0].el.click()
      return true
    })
    .catch(() => false)

  if (byAria) return true

  return clickByText(
    page,
    ['run', 'chạy'],
    5000,
    ['debug', 'gỡ lỗi', 'rename', 'đổi tên', 'save', 'lưu', 'settings', 'untitled']
  )
}

async function generateTotp(secret: string): Promise<string> {
  const compact = secret.replace(/\s+/g, '')
  if (/^\d{6}$/.test(compact)) return compact
  try {
    const OTPAuth = await import('otpauth')
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(compact.toUpperCase()),
      digits: 6,
      period: 30,
      algorithm: 'SHA1'
    })
    return totp.generate()
  } catch {
    throw new Error('Mã 2FA không hợp lệ (cần 6 số hoặc secret Base32).')
  }
}

const TOTP_SELECTORS = [
  'input[name="totpPin"]',
  'input[id="totpPin"]',
  'input[autocomplete="one-time-code"]',
  'input[type="tel"][maxlength="6"]',
  'input[type="text"][maxlength="6"]'
]

async function pageHasText(page: Page, needles: string[]): Promise<boolean> {
  const lowered = needles.map((n) => n.toLowerCase())
  for (const frame of framesOf(page)) {
    try {
      const hit = await frame.evaluate((list) => {
        const text = (document.body?.innerText || '').toLowerCase()
        return list.some((n) => text.includes(n))
      }, lowered)
      if (hit) return true
    } catch {
      continue
    }
  }
  return false
}

/** Toạ độ trong iframe → toạ độ viewport trang (page.mouse) */
async function framePointToPage(
  page: Page,
  frame: Frame,
  point: ClickPoint
): Promise<ClickPoint> {
  if (frame === page.mainFrame()) return point
  try {
    const handle = await frame.frameElement()
    if (!handle) return point
    const box = await handle.boundingBox()
    await handle.dispose().catch(() => undefined)
    if (!box) return point
    return { x: point.x + box.x, y: point.y + box.y }
  } catch {
    return point
  }
}

type OauthUiSnap = {
  heading: string
  chooser: boolean
  signInProject: boolean
  verify: boolean
  consent: boolean
  unverified: boolean
  accounts: string[]
}

const EMPTY_OAUTH_UI: OauthUiSnap = {
  heading: '',
  chooser: false,
  signInProject: false,
  verify: false,
  consent: false,
  unverified: false,
  accounts: []
}

/** Đọc màn OAuth theo heading/hàng tài khoản thật sự visible — không tin innerText của view ẩn. */
async function readOauthUi(page: Page): Promise<OauthUiSnap> {
  let last = EMPTY_OAUTH_UI
  for (const frame of framesOf(page)) {
    try {
      const snap = await frame.evaluate(() => {
        const vis = (el: HTMLElement | null): boolean => {
          if (!el) return false
          const r = el.getBoundingClientRect()
          if (r.width < 4 || r.height < 4) return false
          const s = window.getComputedStyle(el)
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) {
            return false
          }
          if (typeof el.checkVisibility === 'function') {
            try {
              if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
                return false
              }
            } catch {
              // Chromium cũ
            }
          }
          let p: HTMLElement | null = el.parentElement
          while (p && p !== document.body) {
            const ps = window.getComputedStyle(p)
            if (ps.display === 'none' || ps.visibility === 'hidden') return false
            p = p.parentElement
          }
          return true
        }
        const headings = Array.from(
          document.querySelectorAll('h1, h2, #headingText')
        ) as HTMLElement[]
        const heading = headings
          .filter(vis)
          .map((h) => (h.innerText || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ')
          .toLowerCase()
        const body = (document.body?.innerText || '').toLowerCase()
        const accounts: string[] = []
        for (const node of Array.from(
          document.querySelectorAll('[data-identifier], [data-email]')
        ) as HTMLElement[]) {
          const clickable =
            (node.querySelector('[jsname="k6qO0e"], [role="link"]') as HTMLElement | null) || node
          if (!vis(node) && !vis(clickable)) continue
          const id = (
            node.getAttribute('data-identifier') ||
            node.getAttribute('data-email') ||
            ''
          ).trim()
          if (id.includes('@')) accounts.push(id.toLowerCase())
        }

        let hasContinue = false
        let hasCancel = false
        const buttons = Array.from(
          document.querySelectorAll('button[jsname="LgbsSe"], button.VfPpkd-LgbsSe, button')
        ) as HTMLButtonElement[]
        for (const btn of buttons) {
          if (!vis(btn)) continue
          const t = (btn.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (t === 'continue' || t === 'tiếp tục') hasContinue = true
          if (t === 'cancel' || t === 'hủy' || t === 'hủy bỏ') hasCancel = true
        }

        const selectAll =
          body.includes('select all') ||
          body.includes('chọn tất cả') ||
          body.includes('select what')
        // Chỉ heading visible — không dùng view ẩn "Use another account"
        const chooser =
          heading.includes('choose an account') || heading.includes('chọn tài khoản')
        const signInTitle =
          heading.includes('sign in to untitled') ||
          heading.includes('đăng nhập vào untitled') ||
          heading.includes('sign in to') ||
          heading.includes('đăng nhập vào') ||
          body.includes('sign in to untitled') ||
          body.includes('đăng nhập vào untitled') ||
          (body.includes('google will allow') && body.includes('untitled')) ||
          (hasContinue &&
            hasCancel &&
            body.includes('untitled project') &&
            (body.includes('google will allow') ||
              body.includes('sign in with google') ||
              body.includes('email address') ||
              body.includes('địa chỉ email')))
        const signInProject =
          !chooser &&
          !selectAll &&
          hasContinue &&
          hasCancel &&
          signInTitle
        const verify =
          !chooser &&
          (body.includes("verify it's you") ||
            body.includes('verify it’s you') ||
            body.includes('xác minh đó là bạn') ||
            body.includes('xác nhận đó là bạn'))
        const consent =
          !chooser &&
          !signInProject &&
          (selectAll ||
            body.includes('wants access to your') ||
            body.includes('wants to access your') ||
            body.includes('muốn truy cập'))
        const unverified =
          !chooser &&
          !signInProject &&
          (body.includes("google hasn't verified") ||
            body.includes('google hasn’t verified') ||
            body.includes("this app hasn't been verified") ||
            body.includes('this app hasn'))
        return { heading, chooser, signInProject, verify, consent, unverified, accounts }
      })
      last = snap
      if (snap.chooser || snap.signInProject || snap.verify || snap.consent || snap.unverified) {
        return snap
      }
    } catch {
      continue
    }
  }
  return last
}

async function isSignInToProjectScreen(page: Page): Promise<boolean> {
  return (await readOauthUi(page)).signInProject
}

async function isGoogleAccountChooserScreen(page: Page): Promise<boolean> {
  return (await readOauthUi(page)).chooser
}

async function clickLiveElement(page: Page, el: ElementHandle<Element>): Promise<boolean> {
  await el
    .evaluate((node) => {
      ;(node as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' })
    })
    .catch(() => undefined)
  await delay(80)
  const box = await el.boundingBox().catch(() => null)
  if (box && box.width > 2 && box.height > 2) {
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    try {
      await page.mouse.move(x, y, { steps: 4 })
      await delay(40)
      await page.mouse.click(x, y, { delay: 50 })
      return true
    } catch {
      // fallback bên dưới
    }
  }
  try {
    await el.click({ delay: 50 })
    return true
  } catch {
    await el
      .evaluate((node) => {
        const btn = node as HTMLElement
        const opts: MouseEventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          composed: true,
          button: 0,
          buttons: 1
        }
        btn.focus()
        btn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }))
        btn.dispatchEvent(new MouseEvent('mousedown', opts))
        btn.dispatchEvent(
          new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true, buttons: 0 })
        )
        btn.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }))
        btn.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }))
        btn.click()
      })
      .catch(() => undefined)
  }
  return true
}

/**
 * Màn accounts.google.com "Choose an account" (source OAuth):
 * <li data-identifier="mail@..."> <div jsname="k6qO0e" role="link">
 * Nút Continue trên trang này thuộc view Sign-in ẩn — không bấm.
 */
async function clickGoogleAccountChooser(page: Page, email?: string): Promise<boolean> {
  const want = (email || '').trim().toLowerCase()
  for (const frame of framesOf(page)) {
    let handle: Awaited<ReturnType<Frame['evaluateHandle']>> | null = null
    try {
      handle = await frame.evaluateHandle((wantIn: string) => {
        const vis = (el: HTMLElement | null): boolean => {
          if (!el) return false
          const r = el.getBoundingClientRect()
          if (r.width < 8 || r.height < 8) return false
          const s = window.getComputedStyle(el)
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) {
            return false
          }
          let p: HTMLElement | null = el.parentElement
          while (p && p !== document.body) {
            const ps = window.getComputedStyle(p)
            if (ps.display === 'none' || ps.visibility === 'hidden') return false
            p = p.parentElement
          }
          return true
        }
        const skipText = (t: string): boolean =>
          t.includes('use another account') ||
          t.includes('sử dụng tài khoản khác') ||
          t.includes('add another account') ||
          t.includes('add account') ||
          t.includes('thêm tài khoản')

        const scored: Array<{ el: HTMLElement; rank: number }> = []
        const nodes = Array.from(
          document.querySelectorAll(
            'li[data-identifier], div[data-identifier], li[data-email], [jsname="k6qO0e"][role="link"]'
          )
        ) as HTMLElement[]
        for (const node of nodes) {
          const clickable =
            (node.getAttribute('jsname') === 'k6qO0e' ? node : null) ||
            (node.querySelector('[jsname="k6qO0e"]') as HTMLElement | null) ||
            (node.querySelector('[role="link"]') as HTMLElement | null) ||
            node
          if (!vis(clickable) && !vis(node)) continue
          const text = (node.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (skipText(text)) continue
          const host = node.closest('[data-identifier], [data-email]') as HTMLElement | null
          const id = (
            node.getAttribute('data-identifier') ||
            node.getAttribute('data-email') ||
            host?.getAttribute('data-identifier') ||
            host?.getAttribute('data-email') ||
            ''
          ).toLowerCase()
          let rank = 4
          if (wantIn && (id === wantIn || text.includes(wantIn))) rank = 0
          else if (id.includes('@')) rank = 1
          else rank = 3
          scored.push({ el: clickable, rank })
        }
        if (!scored.length) return null
        scored.sort((a, b) => a.rank - b.rank)
        return scored[0].el
      }, want)
      const el = handle.asElement() as ElementHandle<Element> | null
      if (!el) {
        await handle.dispose().catch(() => undefined)
        continue
      }
      await clickLiveElement(page, el)
      await el.dispose().catch(() => undefined)
      await handle.dispose().catch(() => undefined)
      return true
    } catch {
      await handle?.dispose().catch(() => undefined)
      continue
    }
  }
  return false
}

type AccountPickResult = 'ok' | 'skip' | 'fail'

async function pickGoogleOAuthAccount(
  page: Page,
  email?: string,
  timeoutMs = 18000
): Promise<AccountPickResult> {
  await page.bringToFront().catch(() => undefined)
  const started = Date.now()
  let saw = false

  while (Date.now() - started < Math.min(8000, timeoutMs)) {
    const ui = await readOauthUi(page)
    if (ui.chooser) {
      saw = true
      break
    }
    if (ui.signInProject || ui.verify || ui.consent || ui.unverified) return 'skip'
    await delay(300)
  }

  if (!saw) {
    if (!(await isGoogleAccountChooserScreen(page))) return 'skip'
  }

  while (Date.now() - started < timeoutMs) {
    if (!(await isGoogleAccountChooserScreen(page))) return 'ok'
    const clicked = await clickGoogleAccountChooser(page, email)
    await delay(clicked ? 1100 : 400)
    if (!(await isGoogleAccountChooserScreen(page))) return 'ok'
  }

  return 'fail'
}

type SignInContinueResult = 'ok' | 'skip' | 'fail'

/**
 * Nút Material Google: <button jsname="LgbsSe"> <span jsname="V67aGc">Continue</span>
 * Phải click BUTTON (jsaction trên button), không click span / tọa độ mù.
 */
async function clickOAuthLgbsSeButton(page: Page, labels: string[]): Promise<boolean> {
  const needles = labels.map((l) => l.toLowerCase())
  for (const frame of framesOf(page)) {
    let handle: Awaited<ReturnType<Frame['evaluateHandle']>> | null = null
    try {
      handle = await frame.evaluateHandle((needlesIn: string[]) => {
        const vis = (el: HTMLElement): boolean => {
          const r = el.getBoundingClientRect()
          if (r.width < 32 || r.height < 16) return false
          const s = window.getComputedStyle(el)
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) {
            return false
          }
          if (typeof el.checkVisibility === 'function') {
            try {
              if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
                return false
              }
            } catch {
              // ignore
            }
          }
          let p: HTMLElement | null = el.parentElement
          while (p && p !== document.body) {
            const ps = window.getComputedStyle(p)
            if (ps.display === 'none' || ps.visibility === 'hidden') return false
            p = p.parentElement
          }
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          if (top && top !== el && !el.contains(top) && !top.contains(el)) return false
          return true
        }
        const buttons = Array.from(
          document.querySelectorAll('button[jsname="LgbsSe"], button.VfPpkd-LgbsSe')
        ) as HTMLButtonElement[]
        const hits: HTMLButtonElement[] = []
        for (const btn of buttons) {
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue
          const span = btn.querySelector(
            'span[jsname="V67aGc"], span.VfPpkd-vQzf8d'
          ) as HTMLElement | null
          const text = (span?.innerText || btn.innerText || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
          if (!needlesIn.some((n) => text === n)) continue
          if (!vis(btn)) continue
          hits.push(btn)
        }
        if (!hits.length) return null
        hits.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)
        return hits[0]
      }, needles)
      const el = handle.asElement() as ElementHandle<Element> | null
      if (!el) {
        await handle.dispose().catch(() => undefined)
        continue
      }
      await clickLiveElement(page, el)
      await el.dispose().catch(() => undefined)
      await handle.dispose().catch(() => undefined)
      return true
    } catch {
      await handle?.dispose().catch(() => undefined)
      continue
    }
  }
  return false
}

/**
 * Màn OAuth "Sign in to Untitled project" (ảnh): Cancel | Continue.
 * Bấm đúng button[jsname="LgbsSe"] chứa span Continue.
 */
async function clickSignInToProjectContinue(
  page: Page,
  timeoutMs = 25000
): Promise<SignInContinueResult> {
  await page.bringToFront().catch(() => undefined)
  const started = Date.now()
  let sawScreen = false

  const pastSignIn = async (): Promise<boolean> => {
    const ui = await readOauthUi(page)
    if (ui.signInProject || ui.chooser) return false
    // Unverified / Advanced KHÔNG phải đã qua Sign in — Sign in tới SAU "Go to (unsafe)"
    return ui.verify || ui.consent
  }

  const hasAdvancedLink = async (): Promise<boolean> =>
    page
      .evaluate(() => {
        const a = document.querySelector('a[jsname="BO4nrb"]') as HTMLElement | null
        if (!a) return false
        const r = a.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      .catch(() => false)

  while (Date.now() - started < Math.min(15000, timeoutMs)) {
    const ui = await readOauthUi(page)
    if (ui.chooser) return 'skip'
    if (ui.signInProject) {
      sawScreen = true
      break
    }
    // Đang ở interstitial Advanced → Sign in chưa tới, đừng chờ 15s
    if (await hasAdvancedLink()) return 'skip'
    if (await pastSignIn()) return 'skip'
    await delay(300)
  }

  if (!sawScreen) {
    if (await isSignInToProjectScreen(page)) sawScreen = true
    else return 'skip'
  }

  while (Date.now() - started < timeoutMs) {
    if (!(await isSignInToProjectScreen(page))) return 'ok'

    const clicked =
      (await clickOAuthLgbsSeButton(page, ['continue', 'tiếp tục'])) ||
      (await clickExactOAuthButton(page, ['continue', 'tiếp tục']))

    await delay(clicked ? 1200 : 400)
    if (!(await isSignInToProjectScreen(page))) return 'ok'
    if (await pastSignIn()) return 'ok'
  }

  return sawScreen ? 'fail' : 'skip'
}
async function clickV67Label(page: Page, labels: string[]): Promise<boolean> {
  const needles = labels.map((l) => l.toLowerCase())
  for (const frame of framesOf(page)) {
    const clicked = await frame
      .evaluate((needlesIn) => {
        const nodes = Array.from(
          document.querySelectorAll(
            'span[jsname="V67aGc"], span.UywwFc-vQzf8d, span.VfPpkd-vQzf8d'
          )
        ) as HTMLElement[]
        for (const el of nodes) {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
            if (!needlesIn.some((n) => text === n || text.includes(n))) continue
            try {
              el.scrollIntoView({ block: 'center', inline: 'nearest' })
            } catch {
              // ignore
            }
            const r = el.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) continue
          const btn =
            el.closest(
              '[class*="UywwFc"], [class*="VfPpkd"], button, [role="button"], [jsaction], div[tabindex]'
            ) || el
          ;(btn as HTMLElement).click()
          return true
        }
        return false
      }, needles)
      .catch(() => false)
    if (clicked) return true
  }

  return clickByText(page, labels, 4000)
}

async function waitForAuthorizationDialog(page: Page, timeoutMs = 20000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (
      await pageHasText(page, [
        'authorization required',
        'cần ủy quyền',
        'review permissions',
        'xem lại quyền',
        'xem xét quyền'
      ])
    ) {
      return true
    }
    await delay(400)
  }
  return false
}

/** Chờ popup OAuth accounts.google.com sau khi bấm Review permissions */
async function waitForAuthPopup(
  browser: Browser,
  scriptPage: Page,
  timeoutMs = 20000
): Promise<Page> {
  const before = new Set(await browser.pages())
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const p of await browser.pages()) {
      if (p === scriptPage) continue
      const url = p.url().toLowerCase()
      if (
        url.includes('accounts.google.com') ||
        url.includes('accounts.google.') ||
        url.includes('oauth') ||
        url.includes('signin')
      ) {
        await p.bringToFront().catch(() => undefined)
        return p
      }
      // Tab mới vừa mở
      if (!before.has(p) && url && url !== 'about:blank') {
        await p.bringToFront().catch(() => undefined)
        return p
      }
    }
    // Đôi khi auth mở trên cùng tab
    const scriptUrl = scriptPage.url().toLowerCase()
    if (
      scriptUrl.includes('accounts.google.com') ||
      (await pageHasText(scriptPage, ['verify it’s you', "verify it's you", 'xác minh đó là bạn']))
    ) {
      return scriptPage
    }
    await delay(400)
  }
  return scriptPage
}

async function fillTotpOnPage(page: Page, code: string): Promise<boolean> {
  for (const sel of TOTP_SELECTORS) {
    const el = await page.$(sel).catch(() => null)
    if (!el) continue
    const visible = await el
      .evaluate((node) => {
        const r = (node as HTMLElement).getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      .catch(() => false)
    if (!visible) {
      await el.dispose().catch(() => undefined)
      continue
    }

    await el.click({ delay: 30 }).catch(() => undefined)
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await el.type(code, { delay: 60 }).catch(() => undefined)
    await el.dispose().catch(() => undefined)
    return true
  }

  // Fallback: ô input đang focus / input visible gần "verify"
  return page
    .evaluate((pin) => {
      const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[]
      const target = inputs.find((input) => {
        const r = input.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const type = (input.type || '').toLowerCase()
        return (
          type === 'tel' ||
          type === 'text' ||
          type === 'number' ||
          input.autocomplete === 'one-time-code' ||
          input.maxLength === 6
        )
      })
      if (!target) return false
      target.focus()
      target.value = pin
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, code)
    .catch(() => false)
}

/**
 * Sau 2FA: Advanced → Go to Untitled project (unsafe)
 * → Sign in to Untitled project → Continue
 * → Select all / tick checkbox → Continue.
 */
async function completeUnverifiedAppConsent(
  page: Page,
  gmailEmail?: string
): Promise<string[]> {
  const notes: string[] = []

  if (await isGoogleAccountChooserScreen(page)) {
    const picked = await pickGoogleOAuthAccount(page, gmailEmail, 16000)
    notes.push(
      picked === 'ok'
        ? 'đã chọn tài khoản'
        : picked === 'fail'
          ? 'không chọn được tài khoản'
          : 'bỏ qua chọn tài khoản'
    )
    await delay(600)
  }

  const hasConsentScopes = async (): Promise<boolean> =>
    pageHasText(page, [
      'select all',
      'chọn tất cả',
      'select what',
      'see, edit, create, and delete',
      'send email as you',
      'allow this application to run'
    ])

  /** Sau unsafe (hoặc nếu đã tới): Sign in → Continue, rồi mới chờ checkbox. */
  const signInThenWaitScopes = async (timeoutMs: number, tag: string): Promise<void> => {
    const started = Date.now()
    let signNoted = false
    while (Date.now() - started < timeoutMs) {
      if (await isGoogleAccountChooserScreen(page)) {
        const picked = await pickGoogleOAuthAccount(page, gmailEmail, 10000)
        if (picked === 'ok') notes.push(`đã chọn tài khoản (${tag})`)
        await delay(400)
        continue
      }

      if (await isSignInToProjectScreen(page)) {
        const r = await clickSignInToProjectContinue(page, 18000)
        if (!signNoted) {
          notes.push(
            r === 'ok'
              ? `Sign in → Continue (${tag})`
              : r === 'fail'
                ? `Sign in Continue FAIL (${tag})`
                : `không bấm được Sign in Continue (${tag})`
          )
          signNoted = true
        }
        await delay(700)
        continue
      }

      if (await hasConsentScopes()) return
      await delay(350)
    }
    if (!signNoted && !(await hasConsentScopes())) {
      notes.push(`không thấy Sign in / checkbox (${tag})`)
    }
  }

  // Chờ màn cảnh báo unverified — đừng bấm Sign in Continue trước Advanced
  const sawInterstitial = await (async () => {
    const started = Date.now()
    while (Date.now() - started < 20000) {
      if (await isGoogleAccountChooserScreen(page)) {
        const picked = await pickGoogleOAuthAccount(page, gmailEmail, 12000)
        if (picked === 'ok') notes.push('đã chọn tài khoản (chờ Advanced)')
        await delay(400)
        continue
      }

      // Sign in to Untitled project chỉ tới SAU Go to (unsafe) — không bấm Continue ở đây
      if (await isSignInToProjectScreen(page)) {
        return false
      }

      if (await hasConsentScopes()) return false
      if (await pageHasText(page, ['select all', 'chọn tất cả', 'select what'])) return false

      const hasAdvancedLink = await page
        .evaluate(() => {
          const a = document.querySelector('a[jsname="BO4nrb"]') as HTMLElement | null
          if (a) {
            const r = a.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }
          const text = (document.body?.innerText || '').toLowerCase()
          return (
            (text.includes('advanced') || text.includes('nâng cao')) &&
            !text.includes('select all') &&
            !text.includes('chọn tất cả') &&
            !text.includes('select what') &&
            !text.includes('sign in to untitled')
          )
        })
        .catch(() => false)

      if (hasAdvancedLink) return true

      if (
        await pageHasText(page, [
          'this app hasn',
          'google hasn’t verified',
          "google hasn't verified"
        ])
      ) {
        // Banner unverified trên trang consent — không phải interstitial Advanced
        if (await hasConsentScopes()) return false
      }
      await delay(400)
    }
    return false
  })()

  if (sawInterstitial) {
    const advanced =
      (await clickByJsname(page, 'BO4nrb')) ||
      (await clickByText(page, ['advanced', 'nâng cao'], 5000))
    notes.push(advanced ? 'Advanced' : 'không bấm được Advanced')
    await delay(700)

    const goUnsafe =
      (await clickByJsname(page, 'ehL7e')) ||
      (await clickByText(
        page,
        [
          'go to untitled project (unsafe)',
          'go to untitled project',
          'đi tới untitled',
          'unsafe',
          'không an toàn'
        ],
        6000,
        ['google account', 'privacy', 'terms']
      ))
    notes.push(goUnsafe ? 'Go to … (unsafe)' : 'không bấm được Go to (unsafe)')
    await delay(1000)
  }

  // Bắt buộc: Sign in to Untitled project → Continue, rồi mới checkbox
  await signInThenWaitScopes(28000, sawInterstitial ? 'sau unsafe' : 'trước checkbox')

  // 3) Select all — bắt buộc tick trước khi Continue
  let tick = await checkOAuthPermissionBox(page)
  notes.push(
    tick.ok
      ? `đã tick Select all / quyền (${tick.checked}/${tick.total})`
      : `không tick được checkbox (${tick.checked}/${tick.total})`
  )
  await delay(500)

  // 4) Allow (màn cũ, nút đúng chữ "Allow") — không nhầm hàng "Allow this application…"
  const allowed = await clickExactOAuthButton(page, ['allow', 'cho phép'])
  if (allowed) {
    notes.push('Allow')
    await delay(800)
  }

  // 5) Continue — chỉ khi đã chọn quyền; nút đúng chữ Continue (bên phải Cancel)
  const stillConsent = async (): Promise<boolean> =>
    pageHasText(page, [
      'select all',
      'chọn tất cả',
      'select what',
      'wants access to your google account',
      'muốn truy cập'
    ])

  let continued = false
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!tick.ok) {
      tick = await checkOAuthPermissionBox(page)
      if (attempt > 0) notes.push(`retry tick ${tick.checked}/${tick.total}`)
    }
    if (!tick.ok) break
    continued =
      (await clickExactOAuthButton(page, ['continue', 'tiếp tục'])) ||
      (await clickOAuthContinue(page))
    if (!continued) break
    await delay(1000)
    if (!(await stillConsent())) break
    continued = false
    tick = { ok: false, checked: tick.checked, total: tick.total }
  }
  notes.push(continued ? 'Continue' : 'không bấm được Continue')
  await delay(600)

  return notes
}

/** Bấm Continue cuối OAuth (VfPpkd-vQzf8d / UywwFc-vQzf8d) */
async function clickOAuthContinue(page: Page): Promise<boolean> {
  if (await clickOAuthLgbsSeButton(page, ['continue', 'tiếp tục'])) return true
  const started = Date.now()
  while (Date.now() - started < 18000) {
    for (const frame of framesOf(page)) {
      let point: { x: number; y: number } | null = null
      try {
        point = await frame.evaluate(() => {
          const needles = ['continue', 'tiếp tục']
          const nodes = Array.from(
            document.querySelectorAll(
              'span[jsname="V67aGc"].VfPpkd-vQzf8d, span.VfPpkd-vQzf8d[jsname="V67aGc"], span[jsname="V67aGc"], span.UywwFc-vQzf8d, button, div[role="button"]'
            )
          ) as HTMLElement[]
          for (const el of nodes) {
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
            if (!needles.some((n) => text === n)) continue
            const btn =
              (el.closest(
                'button, [role="button"], [class*="VfPpkd"], [class*="UywwFc"], [jsaction], div[tabindex]'
              ) as HTMLElement | null) || el
            const disabled =
              btn.getAttribute('aria-disabled') === 'true' ||
              btn.hasAttribute('disabled') ||
              btn.classList.contains('VfPpkd-ksKsZd-mWPk3d-OWXEXe-AHe6Kc-XpnDCe')
            if (disabled) continue
            try {
              btn.scrollIntoView({ block: 'center', inline: 'nearest' })
            } catch {
              // ignore
            }
            const r = btn.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) continue
            if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) {
              try {
                btn.scrollIntoView({ block: 'center', inline: 'nearest' })
              } catch {
                // ignore
              }
            }
            const box = btn.getBoundingClientRect()
            if (box.width <= 0 || box.height <= 0) continue
            return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
          }
          return null
        })
      } catch {
        continue
      }

      if (point) {
        const abs = await framePointToPage(page, frame, point)
        try {
          await page.mouse.click(abs.x, abs.y, { delay: 40 })
          await delay(600)
          return true
        } catch {
          // fall through to DOM click
        }
        const clicked = await frame
          .evaluate(() => {
            const needles = ['continue', 'tiếp tục']
            const nodes = Array.from(
              document.querySelectorAll(
                'span[jsname="V67aGc"], span.UywwFc-vQzf8d, span.VfPpkd-vQzf8d, button, div[role="button"]'
              )
            ) as HTMLElement[]
            for (const el of nodes) {
              const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
              if (!needles.some((n) => text === n)) continue
              const btn =
                (el.closest(
                  'button, [role="button"], [class*="VfPpkd"], [class*="UywwFc"], [jsaction], div[tabindex]'
                ) as HTMLElement | null) || el
              if (btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('disabled')) {
                continue
              }
              btn.click()
              return true
            }
            return false
          })
          .catch(() => false)
        if (clicked) return true
      }
    }

    if (await clickV67Label(page, ['continue', 'tiếp tục'])) return true
    if (await clickByText(page, ['continue', 'tiếp tục'], 2000, ['create', 'tạo', 'cancel', 'hủy'])) {
      return true
    }
    await delay(400)
  }
  return false
}

async function clickByJsname(page: Page, jsname: string): Promise<boolean> {
  for (const frame of framesOf(page)) {
    const clicked = await frame
      .evaluate((name) => {
        const el = document.querySelector(`[jsname="${name}"]`) as HTMLElement | null
        if (!el) return false
        try {
          el.scrollIntoView({ block: 'center', inline: 'nearest' })
        } catch {
          // ignore
        }
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        el.click()
        return true
      }, jsname)
      .catch(() => false)
    if (clicked) return true
  }
  return false
}

type OAuthTickResult = { ok: boolean; checked: number; total: number }
type OAuthBoxSnap = {
  kind: 'select-all' | 'scope'
  checked: boolean
  x: number
  y: number
}

/** Nút OAuth đúng chữ (Continue / Allow) — không khớp "Allow this application…" */
async function clickExactOAuthButton(page: Page, labels: string[]): Promise<boolean> {
  if (await clickOAuthLgbsSeButton(page, labels)) return true
  const needles = labels.map((l) => l.toLowerCase())
  for (const frame of framesOf(page)) {
    let point: ClickPoint | null = null
    try {
      point = await frame.evaluate((needlesIn) => {
        const nodes = Array.from(
          document.querySelectorAll(
            'button, div[role="button"], span[role="button"], span[jsname="V67aGc"], span.VfPpkd-vQzf8d, span.UywwFc-vQzf8d'
          )
        ) as HTMLElement[]
        const hits: Array<{ x: number; y: number; left: number; yBottom: number }> = []
        for (const el of nodes) {
          const text = (el.innerText || el.getAttribute('aria-label') || el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
          if (!needlesIn.some((n) => text === n)) continue
          const btn =
            (el.closest(
              'button, [role="button"], [class*="VfPpkd"], [class*="UywwFc"], [jsaction]'
            ) as HTMLElement | null) || el
          if (btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('disabled')) continue
          const r = btn.getBoundingClientRect()
          if (r.width < 40 || r.height < 20) continue
          hits.push({
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            left: r.left,
            yBottom: r.bottom
          })
        }
        if (!hits.length) return null
        hits.sort((a, b) => b.yBottom - a.yBottom || b.left - a.left)
        return { x: hits[0].x, y: hits[0].y }
      }, needles)
    } catch {
      continue
    }
    if (!point) continue
    const abs = await framePointToPage(page, frame, point)
    try {
      await page.mouse.move(abs.x, abs.y, { steps: 3 })
      await delay(40)
      await page.mouse.click(abs.x, abs.y, { delay: 40 })
      return true
    } catch {
      continue
    }
  }
  return false
}

async function readOAuthConsentBoxes(
  page: Page
): Promise<{ frame: Frame; boxes: OAuthBoxSnap[] } | null> {
  for (const frame of framesOf(page)) {
    try {
      const boxes = await frame.evaluate(() => {
        const vis = (el: HTMLElement): boolean => {
          try {
            el.scrollIntoView({ block: 'center', inline: 'nearest' })
          } catch {
            // ignore
          }
          const w = window as Window & { __cmReveal?: (el: HTMLElement) => boolean }
          if (typeof w.__cmReveal === 'function') w.__cmReveal(el)
          const r = el.getBoundingClientRect()
          const s = window.getComputedStyle(el)
          return (
            r.width >= 12 &&
            r.height >= 12 &&
            s.display !== 'none' &&
            s.visibility !== 'hidden' &&
            s.opacity !== '0'
          )
        }
        const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
        const isChecked = (el: HTMLElement): boolean => {
          if (el instanceof HTMLInputElement) return el.checked
          const aria = (el.getAttribute('aria-checked') || '').toLowerCase()
          if (aria === 'true') return true
          const input = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null
          if (input?.checked) return true
          const cls = `${el.className || ''}`
          return /OWXEXe-auswjd|OWXEXe-pI13qd/.test(cls)
        }

        const selectAllRect = (() => {
          const els = Array.from(document.querySelectorAll('span, div, label, p, h2, h3')) as HTMLElement[]
          let best: HTMLElement | null = null
          let bestArea = Infinity
          for (const el of els) {
            const t = norm(el.innerText || el.getAttribute('aria-label') || '')
            if (t !== 'select all' && t !== 'chọn tất cả') continue
            try {
              el.scrollIntoView({ block: 'center', inline: 'nearest' })
            } catch {
              // ignore
            }
            const r = el.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) continue
            const area = r.width * r.height
            if (area < bestArea) {
              bestArea = area
              best = el
            }
          }
          return best ? best.getBoundingClientRect() : null
        })()

        const widgets = Array.from(
          document.querySelectorAll(
            '[role="checkbox"], input[type="checkbox"], div.VfPpkd-MPu53c, [jsname="ornU0b"]'
          )
        ) as HTMLElement[]

        const seen = new Set<HTMLElement>()
        const boxes: Array<{
          kind: 'select-all' | 'scope'
          checked: boolean
          x: number
          y: number
        }> = []

        for (const el of widgets) {
          const box = (
            el.getAttribute('role') === 'checkbox'
              ? el
              : el.matches('input[type="checkbox"]')
                ? el
                : ((el.querySelector('[role="checkbox"]') as HTMLElement | null) || el)
          ) as HTMLElement
          if (seen.has(box) || !vis(box)) continue
          seen.add(box)
          const r = box.getBoundingClientRect()
          const sameRow = Boolean(
            selectAllRect &&
              Math.abs(r.top + r.height / 2 - (selectAllRect.top + selectAllRect.height / 2)) < 22
          )
          boxes.push({
            kind: sameRow ? 'select-all' : 'scope',
            checked: isChecked(box),
            x: r.left + Math.min(10, Math.max(6, r.width / 2)),
            y: r.top + r.height / 2
          })
        }

        if (boxes.length === 0 && selectAllRect) {
          const candidates = Array.from(document.querySelectorAll('div, span, input')) as HTMLElement[]
          let best: HTMLElement | null = null
          let bestDx = 9999
          for (const c of candidates) {
            const r = c.getBoundingClientRect()
            if (r.width < 12 || r.width > 44 || r.height < 12 || r.height > 44) continue
            if (Math.abs(r.top + r.height / 2 - (selectAllRect.top + selectAllRect.height / 2)) > 18) {
              continue
            }
            const dx = selectAllRect.left - (r.left + r.width / 2)
            if (dx > 4 && dx < bestDx) {
              bestDx = dx
              best = c
            }
          }
          if (best) {
            const r = best.getBoundingClientRect()
            boxes.push({
              kind: 'select-all',
              checked: isChecked(best),
              x: r.left + Math.min(10, r.width / 2),
              y: r.top + r.height / 2
            })
          }
        }

        return boxes
      })
      if (boxes.length) return { frame, boxes }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Tick quyền OAuth granular: ô Select all bên trái nhãn, rồi từng scope bên phải nếu cần.
 */
async function checkOAuthPermissionBox(page: Page): Promise<OAuthTickResult> {
  await installViewportHelpers(page)
  const tally = (boxes: OAuthBoxSnap[]): OAuthTickResult => {
    const checked = boxes.filter((b) => b.checked).length
    const total = boxes.length
    const selectAllOn = boxes.some((b) => b.kind === 'select-all' && b.checked)
    const scopes = boxes.filter((b) => b.kind === 'scope')
    const scopesOn = scopes.filter((b) => b.checked).length
    const ok =
      selectAllOn ||
      (scopes.length > 0 && scopesOn === scopes.length) ||
      (total > 0 && checked === total)
    return { ok, checked, total }
  }

  const started = Date.now()
  while (Date.now() - started < 22000) {
    const found = await readOAuthConsentBoxes(page)
    if (!found) {
      await delay(400)
      continue
    }
    let { frame, boxes } = found
    let stats = tally(boxes)
    if (stats.ok) return stats

    const selectAll = boxes.find((b) => b.kind === 'select-all' && !b.checked)
    const toClick = selectAll ? [selectAll] : boxes.filter((b) => !b.checked)

    for (const box of toClick) {
      await frame
        .evaluate(
          (x, y) => {
            const el = document.elementFromPoint(x, y) as HTMLElement | null
            const target = el?.closest('[role="checkbox"], input, label, div') as HTMLElement | null
            try {
              ;(target || el)?.scrollIntoView({ block: 'center', inline: 'nearest' })
            } catch {
              // ignore
            }
          },
          box.x,
          box.y
        )
        .catch(() => undefined)
      const abs = await framePointToPage(page, frame, box)
      try {
        await page.mouse.move(abs.x, abs.y, { steps: 2 })
        await delay(40)
        await page.mouse.click(abs.x, abs.y, { delay: 35 })
      } catch {
        try {
          await frame.evaluate(
            (x, y) => {
              const el = document.elementFromPoint(x, y) as HTMLElement | null
              el?.click()
            },
            box.x,
            box.y
          )
        } catch {
          // ignore
        }
      }
      await delay(400)
      const again = await readOAuthConsentBoxes(page)
      if (again) {
        frame = again.frame
        boxes = again.boxes
        stats = tally(boxes)
        if (stats.ok) return stats
      }
    }
    await delay(400)
  }

  const last = await readOAuthConsentBoxes(page)
  return last ? tally(last.boxes) : { ok: false, checked: 0, total: 0 }
}

/**
 * Sau Run: Authorization required → Review permissions → Verify it's you (2FA)
 * → Advanced → Go to Untitled project (unsafe) → tick quyền → Allow.
 */
async function handleAppsScriptAuthorization(
  browser: Browser,
  scriptPage: Page,
  totpSecret?: string,
  gmailEmail?: string
): Promise<string> {
  const authDialog = await waitForAuthorizationDialog(scriptPage, 22000)
  if (!authDialog) {
    return 'không thấy Authorization required (có thể đã cấp quyền)'
  }

  const reviewed = await clickV67Label(scriptPage, [
    'review permissions',
    'xem lại quyền',
    'xem xét quyền',
    'xem quyền'
  ])
  if (!reviewed) {
    const ok = await clickByText(
      scriptPage,
      ['review permissions', 'xem lại quyền', 'xem xét quyền'],
      5000
    )
    if (!ok) return 'thấy Authorization nhưng không bấm được Review permissions'
  }

  await delay(1200)
  const authPage = await waitForAuthPopup(browser, scriptPage, 25000)
  await authPage.bringToFront().catch(() => undefined)
  await installViewportHelpers(authPage)
  await delay(800)

  const signInNotes: string[] = []

  // 0) Popup OAuth thường ra "Choose an account" trước — phải bấm hàng tài khoản,
  // không bấm Continue ẩn của view Sign in.
  const picked = await pickGoogleOAuthAccount(authPage, gmailEmail, 22000)
  if (picked === 'ok') {
    signInNotes.push(gmailEmail ? `đã chọn tài khoản ${gmailEmail}` : 'đã chọn tài khoản')
    await delay(700)
  } else if (picked === 'fail') {
    signInNotes.push('không chọn được tài khoản (Choose an account)')
  }

  // 1) "Sign in to Untitled project" → Continue trước Verify / wants access
  const signIn1 = await clickSignInToProjectContinue(authPage, 28000)
  if (signIn1 === 'ok') signInNotes.push('Sign in → Continue')
  else if (signIn1 === 'fail') signInNotes.push('Sign in Continue FAIL')
  await delay(600)

  // 2) Chờ Verify it’s you (hoặc đã tới consent)
  const verifyStarted = Date.now()
  let sawVerify = false
  while (Date.now() - verifyStarted < 25000) {
    if (await isGoogleAccountChooserScreen(authPage)) {
      const r = await pickGoogleOAuthAccount(authPage, gmailEmail, 12000)
      if (r === 'ok') signInNotes.push('đã chọn tài khoản (lặp)')
      await delay(400)
      continue
    }
    if (await isSignInToProjectScreen(authPage)) {
      const r = await clickSignInToProjectContinue(authPage, 12000)
      if (r === 'ok') signInNotes.push('Sign in → Continue (lặp)')
      await delay(400)
      continue
    }
    if (
      await pageHasText(authPage, [
        "verify it's you",
        'verify it’s you',
        'xác minh đó là bạn',
        'xác nhận đó là bạn',
        '2-step',
        'authenticator',
        'enter the code',
        'nhập mã'
      ])
    ) {
      sawVerify = true
      break
    }
    if (
      await pageHasText(authPage, [
        'select all',
        'chọn tất cả',
        'select what',
        'google hasn’t verified',
        "google hasn't verified",
        'this app hasn',
        'wants to access your',
        'wants access to your',
        'muốn truy cập'
      ])
    ) {
      break
    }
    await delay(400)
  }

  if (sawVerify) {
    if (!totpSecret?.trim()) {
      return 'Review permissions OK · Verify it’s you cần 2FA nhưng thiếu totpSecret'
    }

    await clickByText(
      authPage,
      [
        'google authenticator',
        'authenticator app',
        'ứng dụng xác thực',
        'get a verification code from the google authenticator'
      ],
      3000
    ).catch(() => false)
    await delay(600)

    const code = await generateTotp(totpSecret)
    const filled = await fillTotpOnPage(authPage, code)
    if (!filled) {
      return 'Review permissions OK · thấy Verify nhưng không nhập được ô 2FA'
    }

    await delay(400)
    const nextOk =
      (await clickExactOAuthButton(authPage, ['next', 'tiếp theo', 'continue', 'tiếp tục'])) ||
      (await clickV67Label(authPage, ['next', 'tiếp theo', 'continue', 'tiếp tục', 'done', 'xong'])) ||
      (await clickByText(authPage, ['next', 'tiếp theo', 'continue', 'tiếp tục'], 4000, [
        'cancel',
        'hủy'
      ]))
    if (!nextOk) {
      await authPage.keyboard.press('Enter').catch(() => undefined)
    }
    await delay(1500)

    if (await isGoogleAccountChooserScreen(authPage)) {
      const r = await pickGoogleOAuthAccount(authPage, gmailEmail, 16000)
      if (r === 'ok') signInNotes.push('đã chọn tài khoản (sau 2FA)')
    }

    // Sau 2FA thường hiện lại "Sign in to Untitled project" → Continue rồi mới wants access
    const signIn2 = await clickSignInToProjectContinue(authPage, 20000)
    if (signIn2 === 'ok') signInNotes.push('Sign in → Continue (sau 2FA)')
    else if (signIn2 === 'fail') signInNotes.push('Sign in Continue FAIL (sau 2FA)')
  }

  const consentNotes = await completeUnverifiedAppConsent(authPage, gmailEmail)
  return [
    'Review permissions',
    ...signInNotes,
    sawVerify ? 'đã nhập 2FA' : 'bỏ qua Verify',
    ...consentNotes
  ].join(' · ')
}

async function findSpreadsheetPage(browser: Browser, sheetUrl?: string): Promise<Page | null> {
  const id = sheetUrl?.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/i)?.[1]
  const pages = await browser.pages().catch(() => [] as Page[])
  let fallback: Page | null = null
  for (const page of pages) {
    let url = ''
    try {
      url = page.url()
    } catch {
      continue
    }
    if (id && url.includes(`/spreadsheets/d/${id}`)) return page
    if (/docs\.google\.com\/spreadsheets\/d\//i.test(url)) fallback = page
  }
  return fallback
}

async function waitForSheetsMenubar(page: Page, timeoutMs = 25000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ready = await page
      .evaluate(() => Boolean(document.querySelector('#docs-menubar')))
      .catch(() => false)
    if (ready) return true
    await delay(300)
  }
  return false
}


async function dismissSheetsPopups(page: Page): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape').catch(() => undefined)
    await delay(120)
  }
  await clickByText(
    page,
    ['got it', 'đã hiểu', 'not now', 'để sau', 'no thanks', 'không, cảm ơn'],
    1000,
    ['extensions', 'apps script', 'share', 'chia sẻ', 'menus']
  ).catch(() => false)
  await page.keyboard.press('Escape').catch(() => undefined)
  await delay(120)
}

async function isEditingSheetCell(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return false
      if (el.closest('#docs-menubar, .goog-menu, [role="menu"], [role="listbox"]')) return false
      if (el.closest('#docs-formulabar, .cell-input, .formula-content, #t-formula-bar-input')) {
        return true
      }
      return Boolean(el.isContentEditable && el.closest('#docs-editor, .grid-container'))
    })
    .catch(() => false)
}

function isAppsScriptUrl(url: string): boolean {
  return /script\.google\.com/i.test(url)
}


/** Ô "Menus" trên toolbar Sheet (ảnh) → gõ Apps Script → bấm kết quả. */
async function locateMenusSearchBox(page: Page): Promise<ClickPoint | null> {
  return page
    .evaluate(() => {
      const hints = [
        'menus',
        'menu',
        'thực đơn',
        'các menu',
        'search the menus',
        'tìm trong menu',
        'tìm kiếm menu'
      ]
      const hintOf = (el: HTMLElement): string =>
        (
          el.getAttribute('placeholder') ||
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-placeholder') ||
          el.getAttribute('title') ||
          (el as HTMLInputElement).value ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()

      const inToolbar = (el: HTMLElement): boolean => {
        const r = el.getBoundingClientRect()
        return r.width >= 16 && r.height >= 12 && r.top >= 24 && r.top < 150 && r.left < window.innerWidth * 0.55
      }

      const scopes: ParentNode[] = []
      for (const sel of ['#docs-chrome', '#docs-header', '#docs-bars', '#docs-toolbar']) {
        const n = document.querySelector(sel)
        if (n) scopes.push(n)
      }
      if (!scopes.length) scopes.push(document)

      const pick = (el: HTMLElement): ClickPoint | null => {
        if (!inToolbar(el)) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + Math.min(28, r.width * 0.35), y: r.top + r.height / 2 }
      }

      for (const root of scopes) {
        const nodes = Array.from(
          root.querySelectorAll(
            'input, textarea, [role="combobox"], [role="searchbox"], [placeholder], [aria-label]'
          )
        ) as HTMLElement[]
        for (const el of nodes) {
          const hint = hintOf(el)
          if (!hints.some((h) => hint === h || hint.includes(h))) continue
          const hit = pick(el)
          if (hit) return hit
        }
      }

      // Ô giả (div) với chữ "Menus" + icon kính lúp
      for (const root of scopes) {
        const nodes = Array.from(root.querySelectorAll('div, span, button')) as HTMLElement[]
        for (const el of nodes) {
          const own = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase()
          if (own !== 'menus' && own !== 'menu' && own !== 'thực đơn') continue
          const hit = pick(el)
          if (hit) return hit
        }
      }
      return null
    })
    .catch(() => null)
}

async function clickAppsScriptSearchHit(page: Page): Promise<boolean> {
  const viaDom = await page
    .evaluate(() => {
      const isShown = (el: HTMLElement) => {
        const r = el.getBoundingClientRect()
        const s = window.getComputedStyle(el)
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
        return r.width > 20 && r.height > 12 && r.bottom > 8 && r.top < window.innerHeight
      }
      const nodes = Array.from(
        document.querySelectorAll(
          '[role="option"], [role="menuitem"], .goog-menuitem, .goog-menuitem-content, li'
        )
      ) as HTMLElement[]
      const hits: Array<{ el: HTMLElement; score: number }> = []
      for (const el of nodes) {
        if (!isShown(el)) continue
        const t = (el.innerText || el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        if (!t.includes('apps script') || t.length > 80) continue
        const target =
          (el.closest('[role="option"], [role="menuitem"], .goog-menuitem') as HTMLElement | null) ||
          el
        let score = t === 'apps script' ? 100 : 60
        if (t.includes('extensions') || t.includes('tiện ích')) score += 20
        hits.push({ el: target, score })
      }
      if (!hits.length) return false
      hits.sort((a, b) => b.score - a.score)
      const target = hits[0].el
      target.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 })
      )
      target.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, button: 0 })
      )
      target.click()
      return true
    })
    .catch(() => false)
  if (viaDom) return true

  const local = await page
    .evaluate(() => {
      const isShown = (el: HTMLElement) => {
        const r = el.getBoundingClientRect()
        const s = window.getComputedStyle(el)
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
        return r.width > 20 && r.height > 12 && r.top < window.innerHeight
      }
      const nodes = Array.from(
        document.querySelectorAll(
          '[role="option"], [role="menuitem"], .goog-menuitem, .goog-menuitem-content, li'
        )
      ) as HTMLElement[]
      const hits: Array<{ score: number; x: number; y: number }> = []
      for (const el of nodes) {
        if (!isShown(el)) continue
        const t = (el.innerText || el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        if (!t.includes('apps script') || t.length > 80) continue
        const target =
          (el.closest('[role="option"], [role="menuitem"], .goog-menuitem') as HTMLElement | null) ||
          el
        const r = target.getBoundingClientRect()
        let score = t === 'apps script' ? 100 : 60
        if (t.includes('extensions') || t.includes('tiện ích')) score += 20
        hits.push({
          score,
          x: r.left + Math.min(48, r.width / 2),
          y: r.top + r.height / 2
        })
      }
      if (!hits.length) return null
      hits.sort((a, b) => b.score - a.score)
      return { x: hits[0].x, y: hits[0].y }
    })
    .catch(() => null)

  if (!local) return false
  try {
    await page.mouse.move(local.x, local.y, { steps: 3 })
    await delay(50)
    await page.mouse.click(local.x, local.y, { delay: 35 })
    return true
  } catch {
    return false
  }
}

async function focusSheetsMenuSearch(page: Page): Promise<boolean> {
  await page.keyboard.press('Escape').catch(() => undefined)
  await delay(150)

  const looksLikeMenuSearch = (): Promise<boolean> =>
    page
      .evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el) return false
        if (el.closest('#docs-editor, .grid-container, #docs-formulabar')) return false
        const hint = (
          el.getAttribute('placeholder') ||
          el.getAttribute('aria-label') ||
          el.getAttribute('role') ||
          ''
        ).toLowerCase()
        const tag = el.tagName
        return (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          hint.includes('menu') ||
          hint.includes('combobox') ||
          hint.includes('search')
        )
      })
      .catch(() => false)

  const point = await locateMenusSearchBox(page)
  if (point && (await mouseClickPoint(page, point))) {
    await delay(250)
    if (await looksLikeMenuSearch()) return true
  }

  try {
    await page.click(
      'input[placeholder="Menus"], input[aria-label="Menus"], input[aria-label="Search the menus"]',
      { delay: 30 }
    )
    await delay(250)
    if (await looksLikeMenuSearch()) return true
  } catch {
    // Alt+/ bên dưới
  }

  // Phím tắt Sheets: Alt+/ = Search the menus
  try {
    await page.keyboard.down('Alt')
    await page.keyboard.press('Slash')
    await page.keyboard.up('Alt')
    await delay(350)
  } catch {
    try {
      await page.keyboard.up('Alt')
    } catch {
      // ignore
    }
  }
  return looksLikeMenuSearch()
}

async function openAppsScriptViaMenusSearch(page: Page): Promise<boolean> {
  const focused = await focusSheetsMenuSearch(page)
  if (!focused) return false

  if (await isEditingSheetCell(page)) {
    await page.keyboard.press('Escape').catch(() => undefined)
    await delay(200)
    const again = await focusSheetsMenuSearch(page)
    if (!again || (await isEditingSheetCell(page))) return false
  }

  await delay(150)
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace').catch(() => undefined)
  await delay(80)
  await page.keyboard.type('Apps Script', { delay: 45 })

  const waitHit = Date.now()
  while (Date.now() - waitHit < 5000) {
    if (await clickAppsScriptSearchHit(page)) return true
    await delay(300)
  }
  return false
}

async function waitForAppsScriptPage(
  browser: Browser,
  beforePages: Set<Page>,
  timeoutMs = 35000
): Promise<Page | null> {
  const started = Date.now()
  let found: Page | null = null

  const consider = (page: Page | null): Page | null => {
    if (!page) return null
    try {
      return isAppsScriptUrl(page.url()) ? page : null
    } catch {
      return null
    }
  }

  const onTarget = (target: Target): void => {
    if (target.type() !== 'page') return
    void target.page().then(async (p) => {
      if (!p) return
      while (Date.now() - started < timeoutMs && !found) {
        const hit = consider(p)
        if (hit) {
          found = hit
          return
        }
        await delay(200)
      }
    })
  }
  browser.on('targetcreated', onTarget)

  try {
    while (Date.now() - started < timeoutMs) {
      if (found) return found
      const pages = await browser.pages().catch(() => [] as Page[])
      const fresh = pages.filter((p) => !beforePages.has(p))
      const rest = pages.filter((p) => beforePages.has(p))
      for (const page of [...fresh, ...rest]) {
        const hit = consider(page)
        if (hit) return hit
      }
      await delay(250)
    }
    return found
  } finally {
    browser.off('targetcreated', onTarget)
  }
}

async function openAppsScriptViaBoundUrl(
  browser: Browser,
  sheetPage: Page
): Promise<Page | null> {
  const id = sheetPage.url().match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/i)?.[1]
  if (!id) return null
  try {
    const page = await createPage(browser)
    await page.goto(`https://script.google.com/u/0/home/cli_romeo/${id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    })
    const started = Date.now()
    while (Date.now() - started < 25000) {
      try {
        if (isAppsScriptUrl(page.url())) return page
      } catch {
        return null
      }
      await delay(300)
    }
    return page
  } catch {
    return null
  }
}

type OpenScriptResult = { page: Page | null; detail: string }

/**
 * Mở Apps Script gắn với Spreadsheet: ô Menus → gõ Apps Script (tab mới).
 * Không dùng Extensions. Fallback URL bound script.
 */
async function openAppsScriptFromSheet(browser: Browser, sheetPage: Page): Promise<OpenScriptResult> {
  await sheetPage.bringToFront().catch(() => undefined)
  const menubar = await waitForSheetsMenubar(sheetPage, 25000)
  if (!menubar) {
    const viaUrl = await openAppsScriptViaBoundUrl(browser, sheetPage)
    if (viaUrl) return { page: viaUrl, detail: 'URL bound script (không thấy menubar)' }
    return { page: null, detail: 'Sheet chưa hiện thanh menu / ô Menus.' }
  }

  await dismissSheetsPopups(sheetPage)
  await delay(200)

  const waitMenus = Date.now()
  while (Date.now() - waitMenus < 8000) {
    if (await locateMenusSearchBox(sheetPage)) break
    await delay(250)
  }

  const beforePages = new Set(await browser.pages().catch(() => [] as Page[]))
  const reasons: string[] = []

  for (let attempt = 1; attempt <= 3; attempt++) {
    await sheetPage.bringToFront().catch(() => undefined)
    await dismissSheetsPopups(sheetPage)
    const viaSearch = await openAppsScriptViaMenusSearch(sheetPage)
    if (!viaSearch) {
      reasons.push(`ô Menus không chọn được Apps Script (lần ${attempt})`)
      continue
    }
    const page = await waitForAppsScriptPage(browser, beforePages, 18000)
    if (page) {
      return {
        page,
        detail: attempt > 1 ? 'ô Menus → Apps Script (retry)' : 'ô Menus → Apps Script'
      }
    }
    reasons.push(`ô Menus đã chọn nhưng chưa có tab (lần ${attempt})`)
  }

  const viaUrl = await openAppsScriptViaBoundUrl(browser, sheetPage)
  if (viaUrl) return { page: viaUrl, detail: 'URL bound script (fallback)' }

  const late = await waitForAppsScriptPage(browser, beforePages, 4000)
  if (late) return { page: late, detail: 'tab Apps Script' }

  return {
    page: null,
    detail: reasons.slice(-3).join(' · ') || 'Không mở được Apps Script từ ô Menus.'
  }
}

async function pasteAppsScript(
  browser: Browser,
  options: {
    appsScriptPath?: string
    appsScriptCode?: string
    totpSecret?: string
    gmailEmail?: string
    sheetUrl?: string
    formUrl?: string
  }
): Promise<PostSetupStepResult> {
  let code = ''
  let source = ''
  try {
    const resolved = resolveAppsScriptCode(options)
    code = resolved.code
    source = resolved.source
  } catch (error) {
    return {
      step: 'script',
      ok: false,
      detail: error instanceof Error ? error.message : 'Không đọc được file Apps Script.'
    }
  }

  if (!code.trim()) {
    return { step: 'script', ok: false, detail: 'Chưa chọn file / nhập code Apps Script — bỏ qua.' }
  }

  const injected = injectPlaceholders(code, {
    sheetUrl: options.sheetUrl,
    formUrl: options.formUrl
  })
  if (injected.missingSheet) {
    return {
      step: 'script',
      ok: false,
      detail: `Code có ${LINK_SHEET_TOKEN} nhưng chưa có URL Spreadsheet vừa tạo.`
    }
  }
  if (injected.missingForm) {
    return {
      step: 'script',
      ok: false,
      detail: `Code có ${LINK_FORM_TOKEN} nhưng chưa lấy được link Form (Publish).`
    }
  }
  code = injected.code
  const linkNotes: string[] = []
  if (injected.sheetReplaced > 0) {
    linkNotes.push(`đã thay ${injected.sheetReplaced}× ${LINK_SHEET_TOKEN} → ${options.sheetUrl}`)
  }
  if (injected.formReplaced > 0) {
    linkNotes.push(`đã thay ${injected.formReplaced}× ${LINK_FORM_TOKEN} → ${options.formUrl}`)
  }
  const linkNote = linkNotes.length ? ` · ${linkNotes.join(' · ')}` : ''

  try {
    const sheetPage = await findSpreadsheetPage(browser, options.sheetUrl)
    if (!sheetPage) {
      return {
        step: 'script',
        ok: false,
        detail: 'Không tìm thấy tab Spreadsheet để mở ô Menus → Apps Script.'
      }
    }

    await sheetPage.bringToFront().catch(() => undefined)
    await delay(400)

    const opened = await openAppsScriptFromSheet(browser, sheetPage)
    const page = opened.page
    if (!page) {
      return {
        step: 'script',
        ok: false,
        detail: `Không mở được Apps Script từ Sheet (${opened.detail})`
      }
    }

    await page.bringToFront().catch(() => undefined)
    await delay(1500)

    const ready = await waitForScriptEditor(page, 60000)
    if (!ready) {
      return {
        step: 'script',
        ok: false,
        detail: `Apps Script mở nhưng chưa thấy editor (${page.url()}) — tab vẫn giữ.`
      }
    }

    await delay(1500)
    // Chỉ focus file Code.gs — không bấm tiêu đề project / đổi tên
    await clickByText(
      page,
      ['code.gs', 'code'],
      2500,
      ['untitled', 'không có tiêu đề', 'rename', 'đổi tên', 'project']
    ).catch(() => false)
    await delay(400)

    const focused = await focusScriptEditor(page)
    if (!focused) {
      return {
        step: 'script',
        ok: false,
        detail: 'Không focus được editor Apps Script — tab vẫn được giữ.'
      }
    }

    await delay(300)
    const method = await setEditorContent(page, code)
    await delay(800)

    const snippet = await readEditorSnippet(page)
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
    const expected = norm(code).slice(0, 60)
    const got = norm(snippet)
    let pasteOk =
      got.includes(expected.slice(0, Math.min(30, expected.length))) ||
      (expected.length > 0 && got.length >= Math.min(expected.length, 40))

    if (!pasteOk) {
      await focusScriptEditor(page)
      await withClipboard(async () => {
        const previous = clipboard.readText()
        try {
          clipboard.writeText(code)
          await page.keyboard.down('Control')
          await page.keyboard.press('KeyA')
          await page.keyboard.up('Control')
          await delay(100)
          await page.keyboard.down('Control')
          await page.keyboard.press('KeyV')
          await page.keyboard.up('Control')
          await delay(700)
        } finally {
          try {
            clipboard.writeText(previous)
          } catch {
            // ignore
          }
        }
      })

      const snippet2 = await readEditorSnippet(page)
      const got2 = norm(snippet2)
      pasteOk =
        got2.includes(expected.slice(0, Math.min(30, expected.length))) ||
        (expected.length > 0 && got2.length >= Math.min(expected.length, 40))

      if (!pasteOk) {
        return {
          step: 'script',
          ok: false,
          detail: `Không xác nhận được code trong editor (cách: ${method}, nguồn: ${source || 'n/a'}). Tab Apps Script vẫn mở — hãy Ctrl+V tay từ file .txt.`
        }
      }
    }

    // Lưu (Ctrl+S) → Run → Authorization / Review permissions → 2FA
    await saveAppsScript(page)
    await delay(600)
    const ran = await runAppsScript(page)
    await delay(1200)

    const pasteDetail = `Sheet → ${opened.detail} · đã dán code từ ${source || 'file'} (${code.length} ký tự, ${method})${linkNote}`
    if (!ran) {
      return {
        step: 'script',
        ok: true,
        detail: `${pasteDetail} · đã Ctrl+S · chưa bấm được Run — hãy Run tay.`
      }
    }

    const authDetail = await handleAppsScriptAuthorization(
      browser,
      page,
      options.totpSecret,
      options.gmailEmail
    )

    return {
      step: 'script',
      ok: true,
      detail: `${pasteDetail} · đã Ctrl+S · đã Run · ${authDetail}`
    }
  } catch (error) {
    return {
      step: 'script',
      ok: false,
      detail: error instanceof Error ? error.message : 'Mở/dán Apps Script thất bại'
    }
  }
}

/**
 * Chạy sau login Gmail thành công.
 * Không throw — mọi lỗi trả về steps để caller ghi vào message.
 */
export async function runPostLoginSetup(
  browser: Browser,
  options: Pick<
    GmailLoginOptions,
    | 'avatarPath'
    | 'appsScriptPath'
    | 'appsScriptCode'
    | 'totpSecret'
    | 'formFillEnabled'
    | 'formTitle'
    | 'formDescription'
    | 'formHeaderPath'
    | 'formLinkStyle'
  > & { gmailEmail?: string },
  onStep?: (step: PostSetupStepResult) => void
): Promise<PostSetupStepResult[]> {
  const results: PostSetupStepResult[] = []
  const push = (step: PostSetupStepResult): void => {
    results.push(step)
    onStep?.(step)
  }
  const avatarPath = (options.avatarPath ?? '').trim()

  // Avatar: Personal info → Upload from device (không dùng /acl). Fail thì retry 1 lần.
  let avatarResult = await changeAvatar(browser, avatarPath, options.totpSecret)
  if (avatarPath && !avatarResult.ok) {
    await delay(1500)
    const retry = await changeAvatar(browser, avatarPath, options.totpSecret)
    retry.detail = `Retry · ${retry.detail}`
    avatarResult = retry
  }
  push({
    step: avatarResult.step,
    ok: avatarResult.ok,
    detail: avatarResult.screenshotPath
      ? `${avatarResult.detail} · shot:${avatarResult.screenshotPath}`
      : avatarResult.detail
  })

  const formResult = await openGoogleForm(browser, {
    formFillEnabled: options.formFillEnabled,
    formTitle: options.formTitle,
    formDescription: options.formDescription,
    formHeaderPath: options.formHeaderPath,
    formLinkStyle: options.formLinkStyle
  })
  push({
    step: formResult.step,
    ok: formResult.ok,
    detail: formResult.detail,
    formUrl: formResult.formUrl
  })

  const sheetResult = await openSpreadsheet(browser)
  push({
    step: sheetResult.step,
    ok: sheetResult.ok,
    detail: sheetResult.detail,
    sheetUrl: sheetResult.sheetUrl
  })

  push(
    await pasteAppsScript(browser, {
      appsScriptPath: options.appsScriptPath,
      appsScriptCode: options.appsScriptCode,
      totpSecret: options.totpSecret,
      gmailEmail: options.gmailEmail,
      sheetUrl: sheetResult.sheetUrl,
      formUrl: formResult.formUrl
    })
  )

  return results
}

export function formatPostSetupSummary(steps: PostSetupStepResult[]): string {
  return steps
    .map((s) => {
      const tag = s.ok ? 'OK' : 'WARN'
      return `[${tag} ${s.step}] ${s.detail}`
    })
    .join(' · ')
}
