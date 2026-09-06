import { clipboard } from 'electron'
import type { Browser, Frame, Page } from 'puppeteer-core'
import type { GmailLoginOptions } from '../../shared/types'
import { resolveAppsScriptCode } from './gmail-list.service'
import { changeAvatar } from './gmail-avatar.service'
import { createAsyncLock } from './async-lock'

const SHEET_CREATE_URL = 'https://docs.google.com/spreadsheets/u/0/create'
const FORM_CREATE_URL =
  'https://docs.google.com/forms/u/0/create?usp=forms_home&ths=true'
const SCRIPT_CREATE_URL = 'https://script.google.com/u/0/home/projects/create'

/** Clipboard OS dùng chung — serialize khi nhiều Chrome paste song song */
const withClipboard = createAsyncLock()

export interface PostSetupStepResult {
  step: 'avatar' | 'sheet' | 'form' | 'script' | '2fa-live'
  ok: boolean
  detail: string
  /** URL Spreadsheet vừa tạo (nếu step=sheet) */
  sheetUrl?: string
  /** Mã 6 số lấy từ 2fa.live */
  twoFaCode?: string
}

const LINK_SHEET_TOKEN = '[LINK_SHEET]'

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
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
      await handle.click({ clickCount: 3 })
      await delay(80)
      // Xóa nội dung cũ rồi gõ mới — Forms editor hay là contenteditable
      await page.keyboard.down('Control')
      await page.keyboard.press('KeyA')
      await page.keyboard.up('Control')
      await page.keyboard.press('Backspace')
      await page.keyboard.type(text, { delay: 8 })
      await delay(120)

      const ok = await page.evaluate(
        (sel, expected) => {
          const el = document.querySelector(sel) as HTMLElement | null
          if (!el) return false
          const current = (el.textContent || (el as HTMLTextAreaElement).value || '').trim()
          return current.includes(expected.trim()) || current === expected.trim()
        },
        selector,
        text
      )
      if (ok) return true

      // Fallback set textContent / value + dispatch input
      await page.evaluate(
        (sel, expected) => {
          const el = document.querySelector(sel) as HTMLElement | null
          if (!el) return
          if ('value' in el) {
            const proto = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              'value'
            )
            proto?.set?.call(el, expected)
            ;(el as HTMLTextAreaElement).value = expected
          } else {
            el.focus()
            el.textContent = expected
            el.innerText = expected
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: expected }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          el.dispatchEvent(new Event('blur', { bubbles: true }))
        },
        selector,
        text
      )
      return true
    } catch {
      // thử selector tiếp
    }
  }
  return false
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
      'textarea[aria-label="Form description"]',
      'div[aria-label="Form description"][contenteditable="true"]',
      'textarea[placeholder*="Form description" i]',
      'div[aria-placeholder*="Form description" i]'
    ],
    description
  )

  // Fallback: 2 ô contenteditable đầu trong vùng header Form
  if ((title && !titleOk) || (description && !descOk)) {
    const filled = await page
      .evaluate(
        (payload: { title: string; description: string; needTitle: boolean; needDesc: boolean }) => {
          const editables = Array.from(
            document.querySelectorAll('div[contenteditable="true"], textarea')
          ) as HTMLElement[]
          const visible = editables.filter((el) => {
            const rect = el.getBoundingClientRect()
            return rect.width > 40 && rect.height > 10
          })
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

          if (payload.needTitle && visible[0]) {
            result.titleOk = write(visible[0], payload.title)
          }
          if (payload.needDesc && visible[1]) {
            result.descOk = write(visible[1], payload.description)
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

async function openGoogleForm(
  browser: Browser,
  options?: {
    formFillEnabled?: boolean
    formTitle?: string
    formDescription?: string
  }
): Promise<PostSetupStepResult> {
  try {
    const page = await openUrlInNewTab(browser, FORM_CREATE_URL)
    await delay(1500)
    const formUrl = await waitForFormUrl(page, 35000).catch(() => page.url().split('#')[0])

    const fillOn = Boolean(options?.formFillEnabled)
    const title = (options?.formTitle ?? '').trim()
    const description = (options?.formDescription ?? '').trim()

    if (!fillOn || (!title && !description)) {
      return {
        step: 'form',
        ok: true,
        detail: fillOn
          ? `Đã mở Google Form: ${formUrl} · điền Form tắt (thiếu tiêu đề/mô tả)`
          : `Đã mở Google Form: ${formUrl}`
      }
    }

    const { titleOk, descOk } = await fillGoogleFormFields(page, title, description)
    const parts = [`Đã mở Google Form: ${formUrl}`]
    if (title) parts.push(titleOk ? `title OK` : `title FAIL`)
    if (description) parts.push(descOk ? `desc OK` : `desc FAIL`)
    const fillOk = (!title || titleOk) && (!description || descOk)

    return {
      step: 'form',
      ok: fillOk,
      detail: parts.join(' · ')
    }
  } catch (error) {
    return {
      step: 'form',
      ok: false,
      detail: error instanceof Error ? error.message : 'Mở Google Form thất bại'
    }
  }
}

/** Thay [LINK_SHEET] bằng URL sheet vừa tạo */
function injectSheetLink(code: string, sheetUrl?: string): {
  code: string
  replaced: number
  missingLink: boolean
} {
  const count = (code.match(/\[LINK_SHEET\]/g) || []).length
  if (count === 0) {
    return { code, replaced: 0, missingLink: false }
  }
  if (!sheetUrl?.trim()) {
    return { code, replaced: 0, missingLink: true }
  }
  return {
    code: code.split(LINK_SHEET_TOKEN).join(sheetUrl.trim()),
    replaced: count,
    missingLink: false
  }
}

/** Tạo tab mới ổn định khi connect CDP (fallback Target.createTarget) */
async function createPage(browser: Browser): Promise<Page> {
  try {
    const page = await browser.newPage()
    await page.bringToFront().catch(() => undefined)
    return page
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
      const page = pages[pages.length - 1]
      await page.bringToFront().catch(() => undefined)
      return page
    }
    await delay(200)
  }

  throw new Error('Timeout tạo tab Chrome mới')
}

async function openUrlInNewTab(browser: Browser, url: string): Promise<Page> {
  const page = await createPage(browser)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.bringToFront().catch(() => undefined)
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
    return page.frames()
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
      const clicked = await frame
        .evaluate(
          (needles, blockList) => {
            const nodes = Array.from(
              document.querySelectorAll(
                'button, a, div[role="button"], span[role="button"], li[role="menuitem"], div[role="menuitem"], input[type="submit"]'
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
              candidates.push({ el, label })
            }
            if (candidates.length === 0) return false
            candidates.sort((a, b) => a.label.length - b.label.length)
            candidates[0].el.click()
            return true
          },
          lowered,
          blocked
        )
        .catch(() => false)
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
    // Chỉ bấm tạo project nếu cần — KHÔNG bấm "Untitled project" (đổi tên project)
    await clickByText(
      page,
      ['new project', 'dự án mới', 'start scripting', 'bắt đầu lập trình'],
      800,
      ['untitled', 'không có tiêu đề', 'rename', 'đổi tên', 'project name', 'tên dự án']
    ).catch(() => false)

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
    if (url.includes('/edit') || url.includes('macros')) {
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
  return page
    .evaluate((list) => {
      const text = (document.body?.innerText || '').toLowerCase()
      return list.some((n) => text.includes(n))
    }, lowered)
    .catch(() => false)
}

/** Bấm nhãn Material V67aGc (Review permissions / Next / Continue / Allow...) */
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
 * Sau 2FA: Advanced (jsname=BO4nrb) → Go to Untitled project (unsafe) (jsname=ehL7e)
 * → tick checkbox quyền (jsname=ornU0b / YPqjbf) → Allow.
 */
async function completeUnverifiedAppConsent(page: Page): Promise<string[]> {
  const notes: string[] = []

  // Chờ màn "Google hasn't verified this app"
  const sawWarning = await (async () => {
    const started = Date.now()
    while (Date.now() - started < 20000) {
      if (
        await pageHasText(page, [
          "google hasn't verified",
          'google hasn’t verified',
          'chưa xác minh ứng dụng này',
          'this app isn',
          'advanced'
        ])
      ) {
        return true
      }
      // Đã tới màn chọn quyền / Allow
      if (
        await pageHasText(page, ['wants to access', 'muốn truy cập', 'see, edit', 'allow', 'cho phép'])
      ) {
        return false
      }
      await delay(400)
    }
    return false
  })()

  if (sawWarning) {
    // 1) Advanced — <a jsname="BO4nrb">Advanced</a>
    const advanced =
      (await clickByJsname(page, 'BO4nrb')) ||
      (await clickByText(page, ['advanced', 'nâng cao'], 5000))
    notes.push(advanced ? 'Advanced' : 'không bấm được Advanced')
    await delay(700)

    // 2) Go to Untitled project (unsafe) — <a jsname="ehL7e">
    const goUnsafe =
      (await clickByJsname(page, 'ehL7e')) ||
      (await clickByText(
        page,
        [
          'go to untitled project (unsafe)',
          'go to untitled project',
          'go to',
          'đi tới',
          'unsafe',
          'không an toàn'
        ],
        6000
      ))
    notes.push(goUnsafe ? 'Go to … (unsafe)' : 'không bấm được Go to (unsafe)')
    await delay(1500)
  }

  // 3) Tick checkbox quyền — div[jsname=ornU0b] / input[jsname=YPqjbf]
  const checked = await checkOAuthPermissionBox(page)
  notes.push(checked ? 'đã tick checkbox quyền' : 'không thấy/không tick được checkbox')
  await delay(600)

  // 4) Allow
  const allowed =
    (await clickV67Label(page, ['allow', 'cho phép'])) ||
    (await clickByText(page, ['allow', 'cho phép'], 5000, ['deny', 'từ chối']))
  notes.push(allowed ? 'Allow' : 'không bấm được Allow')
  await delay(1500)

  // 5) Continue — <span jsname="V67aGc" class="VfPpkd-vQzf8d">Continue</span>
  const continued = await clickOAuthContinue(page)
  notes.push(continued ? 'Continue' : 'không bấm được Continue')
  await delay(1000)

  return notes
}

/** Bấm Continue cuối OAuth (VfPpkd-vQzf8d / UywwFc-vQzf8d) */
async function clickOAuthContinue(page: Page): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < 15000) {
    for (const frame of framesOf(page)) {
      const clicked = await frame
        .evaluate(() => {
          const needles = ['continue', 'tiếp tục']
          const nodes = Array.from(
            document.querySelectorAll(
              'span[jsname="V67aGc"].VfPpkd-vQzf8d, span.VfPpkd-vQzf8d[jsname="V67aGc"], span[jsname="V67aGc"], span.UywwFc-vQzf8d'
            )
          ) as HTMLElement[]
          for (const el of nodes) {
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
            if (!needles.some((n) => text === n)) continue
            const r = el.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) continue
            const btn =
              el.closest(
                'button, [role="button"], [class*="VfPpkd"], [class*="UywwFc"], [jsaction], div[tabindex]'
              ) || el
            ;(btn as HTMLElement).click()
            return true
          }
          return false
        })
        .catch(() => false)
      if (clicked) return true
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

/** Tick checkbox OAuth (Material VfPpkd) — jsname ornU0b / YPqjbf / data-value=optioni2 */
async function checkOAuthPermissionBox(page: Page): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < 15000) {
    for (const frame of framesOf(page)) {
      const ok = await frame
        .evaluate(() => {
          const tryCheck = (root: Element | null): boolean => {
            if (!root) return false
            const input =
              (root.querySelector('input[type="checkbox"]') as HTMLInputElement | null) ||
              (root.tagName === 'INPUT' ? (root as HTMLInputElement) : null)
            if (input) {
              if (!input.checked) {
                input.click()
                if (!input.checked) {
                  input.checked = true
                  input.dispatchEvent(new Event('change', { bubbles: true }))
                  input.dispatchEvent(new Event('click', { bubbles: true }))
                }
              }
              return input.checked
            }
            ;(root as HTMLElement).click()
            return true
          }

          // Đúng markup user gửi
          const byOrn =
            document.querySelector('div[jsname="ornU0b"]') ||
            document.querySelector('[jsname="ornU0b"]')
          if (byOrn && tryCheck(byOrn)) return true

          const byInput = document.querySelector('input[jsname="YPqjbf"][type="checkbox"]')
          if (byInput && tryCheck(byInput)) return true

          const byValue = document.querySelector('[data-value="optioni2"]')
          if (byValue && tryCheck(byValue)) return true

          // Mọi checkbox Material chưa tick trên màn consent
          const boxes = Array.from(
            document.querySelectorAll(
              'div.VfPpkd-MPu53c input[type="checkbox"], input.VfPpkd-muHVFf-bMcfAe[type="checkbox"]'
            )
          ) as HTMLInputElement[]
          for (const box of boxes) {
            const r = box.getBoundingClientRect()
            if (r.width <= 0 && r.height <= 0) {
              // input ẩn — click container
              const wrap = box.closest('div.VfPpkd-MPu53c, [jsname="ornU0b"]') as HTMLElement | null
              if (wrap) {
                if (!box.checked) wrap.click()
                if (box.checked) return true
              }
              continue
            }
            if (!box.checked) {
              box.click()
              if (box.checked) return true
            } else {
              return true
            }
          }
          return false
        })
        .catch(() => false)
      if (ok) return true
    }
    await delay(400)
  }
  return false
}

/**
 * Sau Run: Authorization required → Review permissions → Verify it's you (2FA)
 * → Advanced → Go to Untitled project (unsafe) → tick quyền → Allow.
 */
async function handleAppsScriptAuthorization(
  browser: Browser,
  scriptPage: Page,
  totpSecret?: string
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
  await delay(1000)

  // Account chooser / Continue trước Verify (nếu có)
  await clickV67Label(authPage, ['continue', 'tiếp tục', 'next', 'tiếp theo']).catch(() => false)
  await clickByText(authPage, ['continue', 'tiếp tục'], 2500, ['create', 'tạo']).catch(
    () => false
  )
  await delay(800)

  // Chờ Verify it’s you
  const verifyStarted = Date.now()
  let sawVerify = false
  while (Date.now() - verifyStarted < 25000) {
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
        'allow',
        'cho phép',
        'wants to access',
        'muốn truy cập',
        'google hasn’t verified',
        "google hasn't verified",
        'advanced'
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
      (await clickV67Label(authPage, ['next', 'tiếp theo', 'continue', 'tiếp tục', 'done', 'xong'])) ||
      (await clickByText(authPage, ['next', 'tiếp theo', 'continue', 'tiếp tục'], 4000))
    if (!nextOk) {
      await authPage.keyboard.press('Enter').catch(() => undefined)
    }
    await delay(2000)
  }

  const consentNotes = await completeUnverifiedAppConsent(authPage)
  return [
    'Review permissions',
    sawVerify ? 'đã nhập 2FA' : 'bỏ qua Verify',
    ...consentNotes
  ].join(' · ')
}

async function pasteAppsScript(
  browser: Browser,
  options: {
    appsScriptPath?: string
    appsScriptCode?: string
    totpSecret?: string
    sheetUrl?: string
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

  const injected = injectSheetLink(code, options.sheetUrl)
  if (injected.missingLink) {
    return {
      step: 'script',
      ok: false,
      detail: `Code có ${LINK_SHEET_TOKEN} nhưng chưa có URL Spreadsheet vừa tạo.`
    }
  }
  code = injected.code
  const linkNote =
    injected.replaced > 0
      ? ` · đã thay ${injected.replaced}× ${LINK_SHEET_TOKEN} → ${options.sheetUrl}`
      : ''

  try {
    const page = await openUrlInNewTab(browser, SCRIPT_CREATE_URL)
    await delay(2000)

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

    const pasteDetail = `Đã dán code từ ${source || 'file'} (${code.length} ký tự, ${method})${linkNote}`
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
      options.totpSecret
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
  >
): Promise<PostSetupStepResult[]> {
  const results: PostSetupStepResult[] = []
  const avatarPath = (options.avatarPath ?? '').trim()

  // Avatar: Personal info → Upload from device (không dùng /acl). Fail thì retry 1 lần.
  let avatarResult = await changeAvatar(browser, avatarPath, options.totpSecret)
  if (avatarPath && !avatarResult.ok) {
    await delay(1500)
    const retry = await changeAvatar(browser, avatarPath, options.totpSecret)
    retry.detail = `Retry · ${retry.detail}`
    avatarResult = retry
  }
  results.push({
    step: avatarResult.step,
    ok: avatarResult.ok,
    detail: avatarResult.screenshotPath
      ? `${avatarResult.detail} · shot:${avatarResult.screenshotPath}`
      : avatarResult.detail
  })

  const sheetResult = await openSpreadsheet(browser)
  results.push({
    step: sheetResult.step,
    ok: sheetResult.ok,
    detail: sheetResult.detail,
    sheetUrl: sheetResult.sheetUrl
  })
  results.push(
    await openGoogleForm(browser, {
      formFillEnabled: options.formFillEnabled,
      formTitle: options.formTitle,
      formDescription: options.formDescription
    })
  )
  results.push(
    await pasteAppsScript(browser, {
      appsScriptPath: options.appsScriptPath,
      appsScriptCode: options.appsScriptCode,
      totpSecret: options.totpSecret,
      sheetUrl: sheetResult.sheetUrl
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
