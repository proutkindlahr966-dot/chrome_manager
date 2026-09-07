import { clipboard } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { basename, isAbsolute, resolve } from 'path'
import type { Browser, ElementHandle, Frame, Page, Target } from 'puppeteer-core'
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

/** Từ URL edit → link trả lời (viewform) */
function editUrlToViewform(editUrl: string): string | null {
  const m = editUrl.match(/\/forms\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/i)
  if (!m?.[1]) return null
  return `https://docs.google.com/forms/d/${m[1]}/viewform`
}

function looksLikeFormResponderUrl(url: string): boolean {
  const u = url.trim()
  if (!/^https?:\/\//i.test(u)) return false
  if (/forms\.gle\//i.test(u)) return true
  if (/docs\.google\.com\/forms\//i.test(u) && /viewform|formResponse|\/e\//i.test(u)) return true
  return false
}

/**
 * Dialog "Publish form" sau khi bấm Publish trên toolbar:
 * Responders + Anyone with the link → nút tím Publish (không phải Dismiss/Manage).
 */
async function confirmPublishFormDialog(page: Page, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const frame of framesOf(page)) {
      const clicked = await frame
        .evaluate(() => {
          const dialogHints = [
            'publish form',
            'xuất bản biểu mẫu',
            'anyone with the link',
            'bất kỳ ai có đường liên kết',
            'bất kỳ ai có liên kết',
            'nobody will be notified',
            'sẽ không có ai được thông báo'
          ]
          const roots = Array.from(
            document.querySelectorAll('[role="dialog"], [aria-modal="true"]')
          ) as HTMLElement[]

          // Fallback: tìm container có tiêu đề dialog nếu thiếu role=dialog
          const all = roots.length
            ? roots
            : (Array.from(document.querySelectorAll('div')).filter((el) => {
                const t = (el.innerText || '').toLowerCase()
                if (!t || t.length > 1200) return false
                return dialogHints.some((h) => t.includes(h))
              }) as HTMLElement[])

          for (const root of all) {
            const text = (root.innerText || '').toLowerCase()
            if (!dialogHints.some((h) => text.includes(h))) continue

            const buttons = Array.from(
              root.querySelectorAll('button, div[role="button"], span[role="button"]')
            ) as HTMLElement[]

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

            // Ưu tiên nút Publish đúng chữ (không Dismiss / Manage / Cancel)
            const publishBtn = buttons.find((el) => {
              if (!isVisible(el)) return false
              const label = labelOf(el)
              if (!label || label.length > 40) return false
              if (
                label.includes('dismiss') ||
                label.includes('đóng') ||
                label.includes('cancel') ||
                label.includes('hủy') ||
                label.includes('manage') ||
                label.includes('quản lý') ||
                label.includes('unpublish') ||
                label.includes('hủy xuất bản')
              ) {
                return false
              }
              return (
                label === 'publish' ||
                label === 'xuất bản' ||
                label === 'confirm' ||
                label === 'xác nhận' ||
                label === 'publish form' ||
                label === 'xuất bản biểu mẫu'
              )
            })

            if (publishBtn) {
              publishBtn.click()
              return true
            }
          }
          return false
        })
        .catch(() => false)
      if (clicked) return true
    }
    await delay(300)
  }
  return false
}

/**
 * Publish Form (UI mới) hoặc Send → Link (UI cũ), rồi lấy link công khai.
 * Fallback: đổi /edit → /viewform.
 */
async function publishAndGetFormLink(
  page: Page,
  editUrl: string
): Promise<{ link: string; note: string }> {
  const fallback = editUrlToViewform(editUrl) || editUrl.replace(/\/edit.*$/i, '/viewform')
  await page.bringToFront().catch(() => undefined)
  await delay(600)

  // —— UI mới: Publish ——
  const clickedPublish = await clickByText(
    page,
    ['publish', 'xuất bản'],
    5000,
    ['unpublished', 'unpublish', 'hủy xuất bản', 'settings', 'publish form']
  )

  if (clickedPublish) {
    await delay(700)
    // Dialog xác nhận "Publish form" → bấm Publish (tím) lần nữa
    const confirmed = await confirmPublishFormDialog(page, 9000)
    if (!confirmed) {
      // Fallback: clickByText trong dialog (tránh Dismiss/Manage)
      await clickByText(
        page,
        ['publish', 'xuất bản'],
        3500,
        [
          'unpublish',
          'cancel',
          'hủy',
          'close',
          'đóng',
          'manage',
          'quản lý',
          'dismiss',
          'settings',
          'anyone with the link'
        ]
      ).catch(() => false)
    }
    await delay(1500)

    // Copy responder link / Copy link (sau khi publish xong)
    const copied = await clickByText(
      page,
      [
        'copy responder link',
        'copy link',
        'sao chép liên kết',
        'sao chép link',
        'copy form link',
        'copy'
      ],
      6000,
      ['editor', 'email', 'embed', 'dismiss']
    )
    if (copied) {
      await delay(400)
      const fromClip = await withClipboard(async () => {
        try {
          return (clipboard.readText() || '').trim()
        } catch {
          return ''
        }
      })
      if (looksLikeFormResponderUrl(fromClip)) {
        return { link: fromClip.split(/\s+/)[0], note: 'Publish · copy clipboard' }
      }
    }

    // Đọc từ ô input/link trong panel
    const fromInput = await page
      .evaluate(() => {
        const inputs = Array.from(
          document.querySelectorAll('input, textarea, a[href]')
        ) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLAnchorElement>
        for (const el of inputs) {
          const v =
            'href' in el && el.href
              ? el.href
              : 'value' in el
                ? String(el.value || '')
                : ''
          const t = v.trim()
          if (
            /forms\.gle\//i.test(t) ||
            (/docs\.google\.com\/forms\//i.test(t) && /viewform|\/e\//i.test(t))
          ) {
            return t.split(/\s+/)[0]
          }
        }
        return ''
      })
      .catch(() => '')
    if (fromInput && looksLikeFormResponderUrl(fromInput)) {
      return { link: fromInput, note: 'Publish · đọc từ panel' }
    }

    await page.keyboard.press('Escape').catch(() => undefined)
  }

  // —— UI cũ: Send → Link ——
  const clickedSend = await clickByText(
    page,
    ['send', 'gửi'],
    4000,
    ['send feedback', 'gửi ý kiến']
  )
  if (clickedSend) {
    await delay(800)
    await clickByText(page, ['link', 'liên kết'], 4000, ['email', 'embed', 'html']).catch(
      () => false
    )
    await delay(500)

    const fromSend = await page
      .evaluate(() => {
        const inputs = Array.from(
          document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])')
        ) as HTMLInputElement[]
        for (const el of inputs) {
          const v = (el.value || '').trim()
          if (/docs\.google\.com\/forms\//i.test(v) || /forms\.gle\//i.test(v)) {
            return v
          }
        }
        return ''
      })
      .catch(() => '')

    if (fromSend && looksLikeFormResponderUrl(fromSend)) {
      await page.keyboard.press('Escape').catch(() => undefined)
      return { link: fromSend, note: 'Send → Link' }
    }

    await clickByText(page, ['copy', 'sao chép'], 3000).catch(() => false)
    await delay(300)
    const fromClip2 = await withClipboard(async () => {
      try {
        return (clipboard.readText() || '').trim()
      } catch {
        return ''
      }
    })
    if (looksLikeFormResponderUrl(fromClip2)) {
      await page.keyboard.press('Escape').catch(() => undefined)
      return { link: fromClip2.split(/\s+/)[0], note: 'Send → Copy' }
    }
    await page.keyboard.press('Escape').catch(() => undefined)
  }

  return {
    link: fallback,
    note: clickedPublish
      ? 'Publish OK · fallback viewform'
      : clickedSend
        ? 'Send OK · fallback viewform'
        : 'fallback viewform (không bấm được Publish/Send)'
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
            if (rect.top > 120) return null // toolbar trên cùng
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
          const rect = el.getBoundingClientRect()
          if (rect.width < 20 || rect.height < 10) return false
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
    await page.bringToFront().catch(() => undefined)
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

  await delay(2000)

  // 5) Crop dialog / Insert / Done / Save — thử nhiều vòng (trên picker + form)
  let confirmed = false
  for (const host of [uploadHost, page]) {
    for (let i = 0; i < 4; i++) {
      const hit = await clickByText(
        host,
        ['insert', 'chèn', 'done', 'xong', 'save', 'lưu', 'select', 'apply', 'áp dụng', 'next', 'tiếp'],
        3500,
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

  await clickByText(page, ['close', 'đóng'], 2000, ['choose', 'chọn']).catch(() => false)
  await page.keyboard.press('Escape').catch(() => undefined)
  if (uploadHost !== page) {
    await uploadHost.keyboard.press('Escape').catch(() => undefined)
  }

  await page.bringToFront().catch(() => undefined)

  return confirmed
    ? `header OK · ${basename(absPath)} · ${steps.join(' · ')}`
    : `header WARN · đã upload ${basename(absPath)} (chưa chắc Insert/Done) · ${steps.join(' · ')}`
  } finally {
    detachBrowseGuard()
  }
}

async function openGoogleForm(
  browser: Browser,
  options?: {
    formFillEnabled?: boolean
    formTitle?: string
    formDescription?: string
    formHeaderPath?: string
  }
): Promise<PostSetupStepResult & { formUrl?: string }> {
  try {
    const page = await openUrlInNewTab(browser, FORM_CREATE_URL)
    await delay(1500)
    const editUrl = await waitForFormUrl(page, 35000).catch(() => page.url().split('#')[0])

    const fillOn = Boolean(options?.formFillEnabled)
    const title = (options?.formTitle ?? '').trim()
    const description = (options?.formDescription ?? '').trim()
    const headerPath = (options?.formHeaderPath ?? '').trim()

    const parts = [`Đã mở Google Form: ${editUrl}`]
    let ok = true

    // Xóa câu hỏi mặc định (Untitled Question / Option 1) trước khi điền
    await page.bringToFront().catch(() => undefined)
    await delay(800)
    const removedDefault = await deleteDefaultUntitledQuestion(page)
    parts.push(removedDefault ? 'xoá câu hỏi mặc định OK' : 'xoá câu hỏi mặc định FAIL/skip')

    if (fillOn && (title || description)) {
      const { titleOk, descOk } = await fillGoogleFormFields(page, title, description)
      if (title) parts.push(titleOk ? `title OK` : `title FAIL`)
      if (description) parts.push(descOk ? `desc OK` : `desc FAIL`)
      if ((title && !titleOk) || (description && !descOk)) ok = false
    } else if (fillOn) {
      parts.push('điền Form tắt (thiếu tiêu đề/mô tả)')
    }

    if (headerPath) {
      await page.bringToFront().catch(() => undefined)
      await delay(1500)
      const headerNote = await uploadFormHeaderImage(page, headerPath)
      parts.push(headerNote)
      if (headerNote.includes('FAIL')) ok = false
    }

    // Publish xong → lấy link công khai cho [LINK_FORM]
    await page.bringToFront().catch(() => undefined)
    await delay(800)
    const published = await publishAndGetFormLink(page, editUrl)
    parts.push(`link: ${published.note} → ${published.link}`)

    return {
      step: 'form',
      ok,
      detail: parts.join(' · '),
      formUrl: published.link
    }
  } catch (error) {
    return {
      step: 'form',
      ok: false,
      detail: error instanceof Error ? error.message : 'Mở Google Form thất bại'
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
    | 'formHeaderPath'
  >,
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

  const sheetResult = await openSpreadsheet(browser)
  push({
    step: sheetResult.step,
    ok: sheetResult.ok,
    detail: sheetResult.detail,
    sheetUrl: sheetResult.sheetUrl
  })
  const formResult = await openGoogleForm(browser, {
    formFillEnabled: options.formFillEnabled,
    formTitle: options.formTitle,
    formDescription: options.formDescription,
    formHeaderPath: options.formHeaderPath
  })
  push({
    step: formResult.step,
    ok: formResult.ok,
    detail: formResult.detail,
    formUrl: formResult.formUrl
  })
  push(
    await pasteAppsScript(browser, {
      appsScriptPath: options.appsScriptPath,
      appsScriptCode: options.appsScriptCode,
      totpSecret: options.totpSecret,
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
