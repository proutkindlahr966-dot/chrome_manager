import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CheckCircle2,
  Eraser,
  FolderOpen,
  ImagePlus,
  FileCode2,
  Layers,
  ListOrdered,
  Save,
  Square,
  Trash2,
  XCircle
} from 'lucide-react'
import type { ChromeProfile, GmailCredentials, ImagePreview, WindowBounds } from '@shared/types'
import { DEFAULT_GMAIL_POST_SETUP } from '@shared/types'
import { hasGmailCredentials, normalizeEmailKey, parseGmailList } from '@shared/gmail'
import { PageHeader } from '@/components/layout/PageHeader'
import { useAppStore } from '@/stores/app-store'
import { askConfirm, toast } from '@/stores/ui-store'
import { cn } from '@/lib/utils'
import {
  THREADS_MAX,
  THREADS_MIN,
  clampThreads,
  loadSavedThreads,
  persistThreads
} from './threads'

interface RunLogItem {
  id: string
  tone: 'info' | 'success' | 'error' | 'warn'
  text: string
}

interface WorkItem {
  profile: ChromeProfile
  gmail: GmailCredentials
  index: number
  windowBounds?: WindowBounds
}

export function GmailPage(): JSX.Element {
  const groups = useAppStore((s) => s.groups)
  const settings = useAppStore((s) => s.settings)
  const updateProfile = useAppStore((s) => s.updateProfile)
  const bulkUpdateProfiles = useAppStore((s) => s.bulkUpdateProfiles)
  const stopProfiles = useAppStore((s) => s.stopProfiles)
  const refreshAll = useAppStore((s) => s.refreshAll)
  const [clearing, setClearing] = useState(false)
  const [savingList, setSavingList] = useState(false)
  const [listFilePath, setListFilePath] = useState('')

  const [groupId, setGroupId] = useState('')
  const [listText, setListText] = useState('')
  const [autoLoginFlag, setAutoLoginFlag] = useState(true)
  const [threadsInput, setThreadsInput] = useState(() => String(loadSavedThreads()))
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<RunLogItem[]>([])
  const [allProfiles, setAllProfiles] = useState<ChromeProfile[]>([])
  /** Email login lỗi / bỏ qua — chờ xóa khỏi danh sách bằng nút */
  const [failedEmails, setFailedEmails] = useState<string[]>([])
  const [postSetupEnabled, setPostSetupEnabled] = useState(DEFAULT_GMAIL_POST_SETUP.enabled)
  const [avatarPath, setAvatarPath] = useState('')
  const [avatarPreview, setAvatarPreview] = useState<ImagePreview | null>(null)
  const [appsScriptPath, setAppsScriptPath] = useState('')
  const [formFillEnabled, setFormFillEnabled] = useState(DEFAULT_GMAIL_POST_SETUP.formFillEnabled)
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [savingSetup, setSavingSetup] = useState(false)
  const stopRef = useRef(false)
  const logSeq = useRef(0)

  function pushLog(tone: RunLogItem['tone'], text: string): void {
    logSeq.current += 1
    const id = `${Date.now()}-${logSeq.current}`
    setLogs((prev) => [...prev, { id, tone, text }])
  }

  async function reloadProfiles(): Promise<ChromeProfile[]> {
    const all = await window.api.profiles.list()
    setAllProfiles(all)
    return all
  }

  function emailsStillInList(emails: string[], text = listText): string[] {
    const inList = new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim().split('|')[0]?.trim().toLowerCase())
        .filter(Boolean) as string[]
    )
    return emails.filter((e) => inList.has(e.toLowerCase()))
  }

  function persistFailedEmails(emails: string[]): void {
    const next = emailsStillInList(emails)
    setFailedEmails(next)
    void window.api.profiles.saveFailedGmailEmails(next)
  }

  /** Thêm 1 mail lỗi (an toàn khi chạy song song) */
  function markEmailFailed(email: string): void {
    setFailedEmails((prev) => {
      const key = email.toLowerCase()
      if (prev.some((e) => e.toLowerCase() === key)) return prev
      const next = emailsStillInList([...prev, email])
      void window.api.profiles.saveFailedGmailEmails(next)
      return next
    })
  }

  function removeEmailsFromList(emails: string[]): void {
    if (!emails.length) return
    const used = new Set(emails.map((e) => e.toLowerCase()))
    const remain = listText
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim()
        if (!trimmed) return false
        const email = trimmed.split('|')[0]?.trim().toLowerCase()
        return !used.has(email)
      })
    const next = remain.join('\n')
    setListText(next)
    void window.api.profiles.saveGmailList(next).then((r) => {
      setListFilePath(r.path)
    })
  }

  async function removeFailedEmailsFromList(): Promise<void> {
    if (clearing) return
    const targets = emailsStillInList(failedEmails)
    if (targets.length === 0) {
      persistFailedEmails([])
      toast({
        tone: 'info',
        title: 'Không còn mail lỗi trong danh sách'
      })
      return
    }
    const ok = await askConfirm({
      title: `Xóa ${targets.length} mail lỗi / bỏ qua?`,
      description: 'Các dòng tương ứng sẽ bị gỡ khỏi danh sách Gmail.',
      confirmLabel: 'Xóa khỏi list',
      danger: true
    })
    if (!ok) return
    removeEmailsFromList(targets)
    persistFailedEmails([])
    toast({ tone: 'success', title: `Đã xóa ${targets.length} mail lỗi` })
    pushLog('success', `Đã xóa ${targets.length} mail lỗi khỏi danh sách.`)
  }

  async function loadSavedList(): Promise<void> {
    try {
      const saved = await window.api.profiles.loadGmailList()
      setListFilePath(saved.path)
      const content = saved.content
      if (content.trim()) {
        setListText(content)
        const lines = content.split(/\r?\n/).filter((l) => l.trim()).length
        pushLog('info', `Đã tải danh sách Gmail đã lưu (${lines} dòng).`)
      }

      const failed = await window.api.profiles.loadFailedGmailEmails()
      const stillThere = emailsStillInList(failed, content)
      setFailedEmails(stillThere)
      if (stillThere.length !== failed.length) {
        void window.api.profiles.saveFailedGmailEmails(stillThere)
      }
      if (stillThere.length > 0) {
        pushLog(
          'warn',
          `Có ${stillThere.length} mail lỗi từ lần chạy trước — bấm "Xóa mail lỗi" để gỡ khỏi danh sách.`
        )
      }

      const setup = await window.api.profiles.loadGmailSetup()
      setPostSetupEnabled(setup.enabled)
      setAvatarPath(setup.avatarPath)
      setAppsScriptPath(setup.appsScriptPath || '')
      setFormFillEnabled(Boolean(setup.formFillEnabled))
      setFormTitle(setup.formTitle || '')
      setFormDescription(setup.formDescription || '')
      if (setup.avatarPath || setup.appsScriptPath || setup.appsScriptCode.trim()) {
        pushLog(
          'info',
          `Đã tải cấu hình post-login (ảnh: ${setup.avatarPath ? 'có' : 'chưa'} · script: ${setup.appsScriptPath || (setup.appsScriptCode.trim() ? 'inline cũ' : 'chưa')} · form: ${setup.formFillEnabled ? 'bật' : 'tắt'}).`
        )
      }
    } catch {
      // ignore
    }
  }

  async function saveSetup(): Promise<void> {
    if (savingSetup) return
    setSavingSetup(true)
    try {
      const result = await window.api.profiles.saveGmailSetup({
        enabled: postSetupEnabled,
        avatarPath,
        appsScriptPath,
        appsScriptCode: '',
        formFillEnabled,
        formTitle,
        formDescription
      })
      setAvatarPath(result.config.avatarPath)
      setAppsScriptPath(result.config.appsScriptPath)
      setPostSetupEnabled(result.config.enabled)
      setFormFillEnabled(result.config.formFillEnabled)
      setFormTitle(result.config.formTitle)
      setFormDescription(result.config.formDescription)
      pushLog('success', `Đã lưu cấu hình post-login → ${result.path}`)
    } catch (error) {
      pushLog(
        'error',
        `Lưu cấu hình thất bại: ${error instanceof Error ? error.message : 'Không rõ'}`
      )
    } finally {
      setSavingSetup(false)
    }
  }

  async function pickAvatar(): Promise<void> {
    const path = await window.api.profiles.pickImageFile()
    if (!path) return
    setAvatarPath(path)
    const preview = await window.api.profiles.readImagePreview(path).catch(() => null)
    setAvatarPreview(preview)
    pushLog(
      preview?.exists ? 'info' : 'warn',
      preview?.exists
        ? `Đã chọn ảnh đại diện: ${path}`
        : `Ảnh không đọc được: ${path}`
    )
  }

  async function pickAppsScriptFile(): Promise<void> {
    const path = await window.api.profiles.pickScriptTextFile()
    if (!path) return
    setAppsScriptPath(path)
    pushLog('info', `Đã chọn file Apps Script: ${path}`)
  }

  useEffect(() => {
    void reloadProfiles()
    void loadSavedList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Kiểm tra file ảnh thật sự tồn tại + hiện preview (tránh đường dẫn sai mà không biết)
  useEffect(() => {
    const path = avatarPath.trim()
    if (!path) {
      setAvatarPreview(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.api.profiles
        .readImagePreview(path)
        .then((preview) => {
          if (!cancelled) setAvatarPreview(preview)
        })
        .catch(() => {
          if (!cancelled) setAvatarPreview(null)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [avatarPath])

  async function saveList(): Promise<void> {
    if (savingList) return
    if (!listText.trim()) {
      toast({ tone: 'warning', title: 'Danh sách đang trống — không có gì để lưu.' })
      return
    }
    setSavingList(true)
    try {
      const result = await window.api.profiles.saveGmailList(listText)
      setListFilePath(result.path)
      pushLog('success', `Đã lưu ${result.count} dòng Gmail → ${result.path}`)
    } catch (error) {
      pushLog(
        'error',
        `Lưu danh sách thất bại: ${error instanceof Error ? error.message : 'Không rõ'}`
      )
    } finally {
      setSavingList(false)
    }
  }

  useEffect(() => {
    if (!groupId && groups.length > 0) setGroupId(groups[0].id)
  }, [groups, groupId])

  useEffect(() => {
    const max = settings?.maxConcurrentLaunches
    if (!max || max <= 0) return
    setThreadsInput((prev) => {
      const current = clampThreads(Number(prev) || THREADS_MIN)
      const next = Math.min(current, max)
      if (next === current) return prev
      persistThreads(next)
      return String(next)
    })
  }, [settings?.maxConcurrentLaunches])

  const gmailQueue = useMemo(() => parseGmailList(listText), [listText])

  /** Email đã gắn bất kỳ profile nào (mọi nhóm) */
  const usedEmailsGlobal = useMemo(() => {
    const set = new Set<string>()
    for (const p of allProfiles) {
      if (!hasGmailCredentials(p.gmail)) continue
      const key = normalizeEmailKey(p.gmail?.email)
      if (key) set.add(key)
    }
    return set
  }, [allProfiles])

  /** Hàng đợi còn dùng được: chưa gắn profile nào */
  const availableQueue = useMemo(
    () => gmailQueue.filter((g) => !usedEmailsGlobal.has(normalizeEmailKey(g.email))),
    [gmailQueue, usedEmailsGlobal]
  )

  const duplicateInList = useMemo(
    () => gmailQueue.filter((g) => usedEmailsGlobal.has(normalizeEmailKey(g.email))),
    [gmailQueue, usedEmailsGlobal]
  )

  /** Gỡ khỏi danh sách các mail đã gắn profile (đã đăng nhập thành công) */
  async function removeLoggedInEmailsFromList(): Promise<void> {
    if (clearing || running) return
    const targets = duplicateInList.map((g) => g.email)
    if (targets.length === 0) {
      toast({
        tone: 'info',
        title: 'Không có mail nào trong danh sách đã đăng nhập thành công.'
      })
      return
    }
    const ok = await askConfirm({
      title: `Xóa ${targets.length} mail đã đăng nhập?`,
      description: 'Không xóa Gmail trên hồ sơ — chỉ gỡ dòng trong list.',
      confirmLabel: 'Xóa khỏi list',
      danger: true
    })
    if (!ok) return
    removeEmailsFromList(targets)
    persistFailedEmails(failedEmails.filter((e) => !usedEmailsGlobal.has(normalizeEmailKey(e))))
    pushLog('success', `Đã xóa ${targets.length} mail đã đăng nhập thành công khỏi danh sách.`)
  }

  const groupProfiles = useMemo(() => {
    return allProfiles
      .filter((p) => p.groupId === groupId)
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
  }, [allProfiles, groupId])

  const emptySlots = useMemo(
    () => groupProfiles.filter((p) => !hasGmailCredentials(p.gmail)),
    [groupProfiles]
  )

  const filledCount = groupProfiles.length - emptySlots.length
  const filledProfiles = useMemo(
    () => groupProfiles.filter((p) => hasGmailCredentials(p.gmail)),
    [groupProfiles]
  )
  const willUse = Math.min(emptySlots.length, availableQueue.length)
  const safeThreads = clampThreads(Number(threadsInput) || THREADS_MIN)
  const parallelNow = Math.min(safeThreads, willUse)

  function commitThreadsInput(raw: string): void {
    const next = clampThreads(Number(raw) || THREADS_MIN)
    setThreadsInput(String(next))
    persistThreads(next)
  }

  async function clearGroupGmail(): Promise<void> {
    if (running || clearing) return
    if (!groupId) {
      toast({ tone: 'warning', title: 'Hãy chọn nhóm trước.' })
      return
    }
    if (filledProfiles.length === 0) {
      toast({ tone: 'info', title: 'Nhóm này chưa có hồ sơ nào gắn Gmail.' })
      return
    }

    const ok = await askConfirm({
      title: `Xóa Gmail của ${filledProfiles.length} hồ sơ?`,
      description:
        'Thông tin mail/pass sẽ bị gỡ khỏi hồ sơ. Chrome đang mở cũng sẽ được đóng.',
      confirmLabel: 'Xóa Gmail',
      danger: true
    })
    if (!ok) return

    setClearing(true)
    pushLog('info', `Đang xóa Gmail trên ${filledProfiles.length} hồ sơ trong nhóm...`)
    try {
      const ids = filledProfiles.map((p) => p.id)
      await stopProfiles(ids).catch(() => undefined)
      await bulkUpdateProfiles(ids, { gmail: null, autoLoginGmail: false })
      await reloadProfiles()
      await refreshAll()
      pushLog('success', `Đã xóa Gmail khỏi ${ids.length} hồ sơ. Nhóm còn trống để đổ lại.`)
    } catch (error) {
      pushLog(
        'error',
        `Xóa Gmail thất bại: ${error instanceof Error ? error.message : 'Không rõ'}`
      )
    } finally {
      setClearing(false)
    }
  }

  async function processOne(
    item: WorkItem,
    total: number,
    staggerMs = 0
  ): Promise<{
    email: string
    filled: boolean
    skipped: boolean
    isRobot?: boolean
    alreadyUsed?: boolean
  }> {
    const { profile, gmail, index, windowBounds } = item
    if (staggerMs > 0) {
      await new Promise((r) => setTimeout(r, staggerMs))
    }
    pushLog(
      'info',
      `[Luồng] ${index + 1}/${total}: ${gmail.email} → ${profile.name}` +
        (staggerMs > 0 ? ` · trễ ${Math.round(staggerMs / 1000)}s` : '') +
        (postSetupEnabled
          ? ` · post-setup ON (ảnh: ${avatarPath ? 'có' : 'không'} · script: ${appsScriptPath ? 'có' : 'không'} · form: ${formFillEnabled ? 'điền' : 'không'})`
          : ' · post-setup OFF')
    )

    try {
      // Chặn sớm nếu mail đã gắn profile khác
      const latest = await reloadProfiles()
      const conflict = latest.find(
        (p) =>
          p.id !== profile.id &&
          hasGmailCredentials(p.gmail) &&
          normalizeEmailKey(p.gmail?.email) === normalizeEmailKey(gmail.email)
      )
      if (conflict) {
        pushLog(
          'warn',
          `Bỏ qua ${gmail.email} — đã gắn hồ sơ "${conflict.name}" (mọi nhóm, 1 mail = 1 profile).`
        )
        return { email: gmail.email, filled: false, skipped: true, isRobot: false, alreadyUsed: true }
      }

      // Lưu setup ngay trước login để main đọc fallback từ file nếu cần
      if (postSetupEnabled) {
        await window.api.profiles
          .saveGmailSetup({
            enabled: true,
            avatarPath,
            appsScriptPath,
            appsScriptCode: '',
            formFillEnabled,
            formTitle,
            formDescription
          })
          .catch(() => undefined)
      }

      // Không gắn Gmail vào hồ sơ trước — chỉ lưu khi main xác nhận đã vào inbox
      const result = await window.api.profiles.loginGmail(profile.id, {
        windowBounds,
        credentials: gmail,
        autoLoginGmail: autoLoginFlag,
        preferExistingSession: false,
        postLoginSetup: postSetupEnabled,
        avatarPath: avatarPath || undefined,
        appsScriptPath: appsScriptPath || undefined,
        formFillEnabled,
        formTitle: formTitle || undefined,
        formDescription: formDescription || undefined
      })

      if (result.success) {
        const latest = await reloadProfiles()
        const saved = latest.find((p) => p.id === profile.id)
        const ok = hasGmailCredentials(saved?.gmail) && saved?.gmail?.email === gmail.email
        if (!ok) {
          // Fallback lưu từ UI nếu main chưa kịp sync
          await updateProfile(profile.id, {
            gmail,
            autoLoginGmail: autoLoginFlag
          })
        }
        pushLog(
          'success',
          result.message || `OK & đã lưu hồ sơ: ${profile.name} ← ${gmail.email}`
        )
        return { email: gmail.email, filled: true, skipped: false }
      }

      const err = result.error || 'Không rõ'
      const errLower = err.toLowerCase()
      if (errLower.includes('google authenticator') || errLower.includes('2fa')) {
        pushLog('warn', `${gmail.email} — xem log kỹ: data/gmail-login-debug.log`)
      }
      const alreadyUsed =
        errLower.includes('đã gắn hồ sơ') || errLower.includes('mỗi mail chỉ dùng 1 profile')
      const isRobot =
        errLower.includes('not a robot') ||
        errLower.includes("you're not a robot") ||
        errLower.includes('youre not a robot') ||
        errLower.includes('không phải là robot') ||
        errLower.includes('unusual traffic') ||
        (errLower.includes('robot') && errLower.includes('confirm'))
      const passwordChanged =
        errLower.includes('password was changed') ||
        errLower.includes('mật khẩu đã được thay đổi') ||
        errLower.includes('mật khẩu đã thay đổi')
      const incorrect2fa =
        errLower.includes('2fa không chính xác') || errLower.includes('mã 2fa không chính xác')
      const missing2faSecret =
        errLower.includes('thiếu secret 2fa') ||
        errLower.includes('thiếu mã 2fa') ||
        errLower.includes('chưa có mã 2fa') ||
        errLower.includes('secret 2fa không hợp lệ') ||
        errLower.includes('2fa secret không hợp lệ') ||
        errLower.includes('mã 2fa không hợp lệ') ||
        errLower.includes('mã 2fa không phải 6')
      const totpInputFailed =
        errLower.includes('không nhập được mã 2fa') ||
        errLower.includes('không thấy ô nhập mã') ||
        errLower.includes('không tạo được mã totp') ||
        errLower.includes('không vượt qua bước nhập mã 2fa')
      const skipped =
        err.includes('[BỎ QUA]') ||
        isRobot ||
        alreadyUsed ||
        passwordChanged ||
        incorrect2fa ||
        missing2faSecret ||
        totpInputFailed

      if (alreadyUsed) {
        pushLog(
          'warn',
          `Bỏ qua ${gmail.email} — ${err.replace(/^\[BỎ QUA\]\s*/i, '')}`
        )
        return { email: gmail.email, filled: false, skipped: true, alreadyUsed: true }
      }

      // Không đụng Gmail trên hồ sơ khi lỗi (chưa từng lưu)
      if (isRobot) {
        pushLog(
          'error',
          `Mail lỗi (${gmail.email}) — Confirm you’re not a robot. Đã ghi vào danh sách "Xóa mail lỗi".`
        )
      } else if (passwordChanged) {
        pushLog(
          'error',
          `Mail lỗi (${gmail.email}) — Your password was changed (mật khẩu đã bị đổi). Đã ghi vào danh sách "Xóa mail lỗi".`
        )
      } else if (missing2faSecret) {
        pushLog(
          'error',
          `Mail lỗi (${gmail.email}) — Thiếu mã 2FA 6 số (cột 3 sau mail|pass|). ${err.replace(/^\[BỎ QUA\]\s*/i, '')}`
        )
      } else if (totpInputFailed) {
        pushLog(
          'error',
          `Mail lỗi (${gmail.email}) — Không nhập/nộp được mã Authenticator. ${err.replace(/^\[BỎ QUA\]\s*/i, '')}`
        )
      } else if (incorrect2fa) {
        pushLog(
          'error',
          `Mail lỗi (${gmail.email}) — Mã 2FA không chính xác (Google từ chối mã đã nộp). Đã ghi log & bỏ qua.`
        )
      } else if (skipped) {
        pushLog(
          'error',
          `Mail lỗi / bỏ qua (${gmail.email}) trên ${profile.name}: ${err.replace(/^\[BỎ QUA\]\s*/i, '')}`
        )
      } else {
        pushLog('error', `Mail lỗi (${gmail.email} → ${profile.name}): ${err}`)
      }

      markEmailFailed(gmail.email)

      return { email: gmail.email, filled: false, skipped, isRobot }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Không rõ'
      pushLog('error', `Mail lỗi ${gmail.email}: ${msg}`)
      markEmailFailed(gmail.email)
      return { email: gmail.email, filled: false, skipped: false, isRobot: false }
    }
  }

  async function runParallelLogin(): Promise<void> {
    if (running) return
    commitThreadsInput(threadsInput)
    if (!groupId) {
      toast({ tone: 'warning', title: 'Hãy chọn nhóm trước.' })
      return
    }
    if (groupProfiles.length === 0) {
      toast({
        tone: 'warning',
        title: 'Nhóm này chưa có hồ sơ. Hãy tạo hồ sơ và gán vào nhóm trước.'
      })
      return
    }
    if (emptySlots.length === 0) {
      toast({ tone: 'info', title: 'Nhóm đã đầy (mọi hồ sơ đều đã có Gmail).' })
      return
    }
    if (gmailQueue.length === 0) {
      toast({
        tone: 'warning',
        title: 'Danh sách Gmail trống',
        description: 'Dán mỗi dòng: mail|pass|2fa (cột 3 = mã 6 số)'
      })
      return
    }
    if (availableQueue.length === 0) {
      toast({
        tone: 'warning',
        title: 'Không còn mail mới để đăng nhập',
        description: 'Mọi mail trong danh sách đã được gắn ở hồ sơ khác.'
      })
      return
    }

    stopRef.current = false
    setRunning(true)
    setLogs([])

    // Lưu cấu hình post-login trước khi chạy
    try {
      await window.api.profiles.saveGmailSetup({
        enabled: postSetupEnabled,
        avatarPath,
        appsScriptPath,
        appsScriptCode: '',
        formFillEnabled,
        formTitle,
        formDescription
      })
    } catch {
      // ignore
    }

    const successEmails: string[] = []
    const runFailed: string[] = []
    let filledNow = 0
    // Email đã dùng toàn cục + đang giữ trong batch hiện tại
    const claimedEmails = new Set(usedEmailsGlobal)
    const queue = [...gmailQueue]
    let gmailIndex = 0

    if (duplicateInList.length > 0) {
      pushLog(
        'warn',
        `Bỏ qua ${duplicateInList.length} mail đã gắn profile khác: ${duplicateInList
          .slice(0, 5)
          .map((g) => g.email)
          .join(', ')}${duplicateInList.length > 5 ? '…' : ''}`
      )
    }

    pushLog(
      'info',
      `Bắt đầu song song ${safeThreads} luồng · slot trống ${emptySlots.length} · mail còn dùng được ${availableQueue.length}/${queue.length}.`
    )

    try {
      while (!stopRef.current) {
        const latest = await reloadProfiles()
        // Cập nhật claimed theo DB mới nhất (mọi nhóm)
        for (const p of latest) {
          if (!hasGmailCredentials(p.gmail)) continue
          const key = normalizeEmailKey(p.gmail?.email)
          if (key) claimedEmails.add(key)
        }

        const slots = latest
          .filter((p) => p.groupId === groupId && !hasGmailCredentials(p.gmail))
          .sort((a, b) => a.name.localeCompare(b.name, 'vi'))

        if (slots.length === 0) {
          pushLog('success', 'Nhóm đã đầy — dừng.')
          break
        }

        const batch: WorkItem[] = []
        const tilesNeeded = Math.min(safeThreads, slots.length)
        // Nhặt mail chưa claimed
        while (batch.length < tilesNeeded && gmailIndex < queue.length) {
          const gmail = queue[gmailIndex]
          const key = normalizeEmailKey(gmail.email)
          gmailIndex += 1
          if (!key || claimedEmails.has(key)) {
            pushLog(
              'warn',
              `Bỏ qua ${gmail.email} — đã gắn profile khác hoặc trùng trong hàng đợi.`
            )
            continue
          }
          claimedEmails.add(key) // giữ chỗ trước khi login xong
          batch.push({
            profile: slots[batch.length],
            gmail,
            index: gmailIndex - 1
          })
        }

        if (batch.length === 0) {
          pushLog('info', 'Hết mail mới trong danh sách — dừng.')
          break
        }

        const tiles = await window.api.profiles.tileLayout(batch.length)
        for (let i = 0; i < batch.length; i++) {
          batch[i].windowBounds = tiles[i]
        }

        pushLog(
          'info',
          `Mở ${batch.length} Chrome chia lưới (mỗi luồng lệch ~1.2s): ${batch
            .map((b) => `${b.gmail.email}→${b.profile.name}`)
            .join(', ')}`
        )

        // Stagger: mỗi Chrome khởi động lệch nhau để thao tác không đồng bộ / dễ nhầm
        const STAGGER_MS = 1200
        const results = await Promise.all(
          batch.map((item, i) => processOne(item, queue.length, i * STAGGER_MS))
        )

        // Sắp lại lần nữa sau khi tất cả đã mở (tránh lệch vị trí)
        await window.api.profiles
          .arrangeWindows(batch.map((b) => b.profile.id))
          .catch(() => undefined)

        for (const r of results) {
          if (r.filled) {
            successEmails.push(r.email)
            filledNow += 1
            claimedEmails.add(normalizeEmailKey(r.email))
          } else if (r.alreadyUsed) {
            // Đã gắn profile khác — không đưa vào "Xóa mail lỗi"
            claimedEmails.add(normalizeEmailKey(r.email))
          } else {
            runFailed.push(r.email)
            claimedEmails.add(normalizeEmailKey(r.email))
          }
        }

        // Cập nhật mail lỗi ngay sau mỗi batch (robot / login fail)
        if (runFailed.length) {
          const merged = [...failedEmails]
          const set = new Set(merged.map((e) => e.toLowerCase()))
          for (const email of runFailed) {
            if (!set.has(email.toLowerCase())) {
              set.add(email.toLowerCase())
              merged.push(email)
            }
          }
          const successSet = new Set(successEmails.map((e) => e.toLowerCase()))
          persistFailedEmails(merged.filter((e) => !successSet.has(e.toLowerCase())))
        }

        if (stopRef.current) {
          pushLog('warn', 'Đã dừng theo yêu cầu.')
          break
        }
      }

      // Chỉ gỡ mail thành công; mail lỗi giữ lại để xem / xóa bằng nút
      removeEmailsFromList(successEmails)
      if (runFailed.length) {
        const successSet = new Set(successEmails.map((e) => e.toLowerCase()))
        // failedEmails state có thể đã được cập nhật từng batch — merge lần cuối từ runFailed
        const merged = [...failedEmails]
        const set = new Set(merged.map((e) => e.toLowerCase()))
        for (const email of runFailed) {
          if (!set.has(email.toLowerCase())) {
            set.add(email.toLowerCase())
            merged.push(email)
          }
        }
        const nextFailed = merged.filter((e) => !successSet.has(e.toLowerCase()))
        persistFailedEmails(nextFailed)
        pushLog(
          'warn',
          `${runFailed.length} mail lỗi (gồm robot/captcha nếu có) — bấm "Xóa mail lỗi" để gỡ khỏi danh sách.`
        )
      } else if (successEmails.length) {
        const successSet = new Set(successEmails.map((e) => e.toLowerCase()))
        persistFailedEmails(failedEmails.filter((e) => !successSet.has(e.toLowerCase())))
      }

      await refreshAll()
      const remainEmpty = (await reloadProfiles()).filter(
        (p) => p.groupId === groupId && !hasGmailCredentials(p.gmail)
      ).length
      pushLog(
        'info',
        `Hoàn tất: login thành công ${filledNow} · lỗi ${runFailed.length} · còn trống trong nhóm: ${remainEmpty}.`
      )
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="animate-fade-up space-y-4">
      <PageHeader
        title="Gmail"
        description="Dán danh sách Gmail, chọn nhóm và số luồng Chrome — đăng nhập song song đến khi đầy nhóm."
        actions={
          <Link to="/profiles" className="btn-secondary">
            Tới Hồ sơ
          </Link>
        }
      />

      {/* Thanh điều khiển chính */}
      <div className="panel p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid flex-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="label">Nhóm cần đổ đầy</label>
              <select
                className="input"
                value={groupId}
                disabled={running}
                onChange={(e) => setGroupId(e.target.value)}
              >
                {groups.length === 0 ? <option value="">Chưa có nhóm</option> : null}
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Số luồng Chrome</label>
              <input
                className="input"
                type="number"
                min={THREADS_MIN}
                max={THREADS_MAX}
                disabled={running}
                value={threadsInput}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '' || /^\d+$/.test(v)) setThreadsInput(v)
                }}
                onBlur={() => commitThreadsInput(threadsInput)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur()
                  }
                }}
              />
              <div className="mt-1 text-[11px] text-ink-muted">
                Nhập {THREADS_MIN}–{THREADS_MAX}, giá trị được nhớ sau khi thoát
              </div>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2.5 pb-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={autoLoginFlag}
                  disabled={running}
                  onChange={(e) => setAutoLoginFlag(e.target.checked)}
                />
                Tự login khi mở
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <button
              type="button"
              className="btn-primary"
              disabled={running || clearing || !groupId || willUse === 0}
              onClick={() => void runParallelLogin()}
            >
              <Layers size={16} />
              {running
                ? `Đang chạy ${safeThreads} luồng...`
                : `Chạy ${parallelNow} luồng`}
            </button>
            {running ? (
              <button
                type="button"
                className="btn-danger"
                onClick={() => {
                  stopRef.current = true
                  pushLog('warn', 'Đang yêu cầu dừng sau batch hiện tại...')
                }}
              >
                <Square size={16} />
                Dừng
              </button>
            ) : null}
            <button
              type="button"
              className="btn-danger"
              disabled={running || clearing || !groupId || filledProfiles.length === 0}
              onClick={() => void clearGroupGmail()}
            >
              <Eraser size={16} />
              {clearing ? 'Đang xóa...' : `Xóa Gmail (${filledProfiles.length})`}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={clearing || running || duplicateInList.length === 0}
              onClick={() => removeLoggedInEmailsFromList()}
              title="Gỡ các mail đã đăng nhập thành công (đã gắn hồ sơ) khỏi danh sách"
            >
              <CheckCircle2 size={16} />
              Mail đã login ({duplicateInList.length})
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={clearing || failedEmails.length === 0}
              onClick={() => removeFailedEmailsFromList()}
              title="Gỡ các mail đã chạy lỗi / robot / bỏ qua khỏi danh sách"
            >
              <XCircle size={16} />
              Mail lỗi ({failedEmails.length})
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.85fr)]">
        {/* Cột trái: danh sách + post-setup */}
        <div className="space-y-4">
          <div className="panel p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-ink">Danh sách Gmail</h2>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Mỗi dòng: <span className="font-mono">mail|pass|2fa</span> (cột 3 = mã 6 số)
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary !py-1.5"
                  disabled={running || savingList || !listText.trim()}
                  onClick={() => void saveList()}
                >
                  <Save size={14} />
                  {savingList ? 'Đang lưu...' : 'Lưu'}
                </button>
                <button
                  type="button"
                  className="btn-secondary !py-1.5"
                  disabled={running || savingList}
                  onClick={() => void loadSavedList()}
                >
                  <FolderOpen size={14} />
                  Tải
                </button>
                {!running ? (
                  <button
                    type="button"
                    className="btn-ghost !py-1.5 text-danger"
                    disabled={!listText.trim() || clearing}
                    onClick={() => {
                      setListText('')
                      persistFailedEmails([])
                      void window.api.profiles.saveGmailList('')
                    }}
                  >
                    <Trash2 size={14} />
                    Xóa hết
                  </button>
                ) : null}
              </div>
            </div>
            <textarea
              className="input min-h-[260px] font-mono text-xs leading-5"
              disabled={running}
              value={listText}
              onChange={(e) => setListText(e.target.value)}
              placeholder={`user1@gmail.com|pass1|123456\nuser2@gmail.com|pass2|654321`}
            />
            {listFilePath ? (
              <div className="mt-2 truncate text-xs text-ink-muted" title={listFilePath}>
                File: <span className="font-mono text-ink-soft">{listFilePath}</span>
              </div>
            ) : null}
          </div>

          <div className="panel p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-ink">Sau khi login</h2>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Đổi ảnh → Sheet → Form → Apps Script (tùy chọn). Sau login luôn mở 2fa.live với
                  cột 3.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={postSetupEnabled}
                  disabled={running}
                  onChange={(e) => setPostSetupEnabled(e.target.checked)}
                />
                Bật auto
              </label>
            </div>

            <div
              className={cn(
                'grid gap-4 transition',
                !postSetupEnabled && 'pointer-events-none opacity-50'
              )}
            >
              <div className="grid gap-3 md:grid-cols-[auto_1fr]">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-muted text-ink-muted">
                  {avatarPreview?.dataUrl ? (
                    <img
                      src={avatarPreview.dataUrl}
                      alt="Ảnh đại diện sẽ dùng"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <ImagePlus size={18} />
                  )}
                </div>
                <div className="min-w-0">
                  <label className="label">Ảnh đại diện</label>
                  <div className="flex gap-2">
                    <input
                      className="input font-mono text-xs"
                      disabled={running || !postSetupEnabled}
                      value={avatarPath}
                      onChange={(e) => setAvatarPath(e.target.value)}
                      placeholder="D:\images\avatar.jpg"
                    />
                    <button
                      type="button"
                      className="btn-secondary shrink-0 !py-2"
                      disabled={running || !postSetupEnabled}
                      onClick={() => void pickAvatar()}
                    >
                      <ImagePlus size={14} />
                      Chọn
                    </button>
                  </div>
                  <div className="mt-1 text-[11px]">
                    {!avatarPath.trim() ? (
                      <span className="text-ink-muted">Chưa chọn ảnh — bước đổi avatar sẽ bỏ qua.</span>
                    ) : avatarPreview?.exists ? (
                      <span className="text-ink-muted">
                        {avatarPreview.name} · {Math.max(1, Math.round(avatarPreview.size / 1024))} KB
                      </span>
                    ) : (
                      <span className="text-danger">Không tìm thấy file ảnh ở đường dẫn này.</span>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <label className="label">File Apps Script (.txt)</label>
                <div className="flex gap-2">
                  <input
                    className="input font-mono text-xs"
                    disabled={running || !postSetupEnabled}
                    value={appsScriptPath}
                    onChange={(e) => setAppsScriptPath(e.target.value)}
                    placeholder="D:\scripts\apps-script.txt"
                  />
                  <button
                    type="button"
                    className="btn-secondary shrink-0 !py-2"
                    disabled={running || !postSetupEnabled}
                    onClick={() => void pickAppsScriptFile()}
                  >
                    <FileCode2 size={14} />
                    Chọn
                  </button>
                  {appsScriptPath ? (
                    <button
                      type="button"
                      className="btn-ghost shrink-0 !px-2 !py-2 text-danger"
                      disabled={running || !postSetupEnabled}
                      onClick={() => setAppsScriptPath('')}
                    >
                      <Trash2 size={14} />
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-line bg-surface-muted/40 p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-ink">Nội dung Google Form</div>
                    <p className="mt-0.5 text-[11px] text-ink-muted">
                      Sau khi mở tab Form, điền tiêu đề và mô tả nếu bật.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-ink-soft">
                    <input
                      type="checkbox"
                      checked={formFillEnabled}
                      disabled={running || !postSetupEnabled}
                      onChange={(e) => setFormFillEnabled(e.target.checked)}
                    />
                    Bật điền Form
                  </label>
                </div>
                <div
                  className={cn(
                    'grid gap-3 transition',
                    !formFillEnabled && 'pointer-events-none opacity-50'
                  )}
                >
                  <div>
                    <label className="label">Untitled form</label>
                    <input
                      className="input text-sm"
                      disabled={running || !postSetupEnabled || !formFillEnabled}
                      value={formTitle}
                      onChange={(e) => setFormTitle(e.target.value)}
                      placeholder="Tiêu đề form"
                    />
                  </div>
                  <div>
                    <label className="label">Form description</label>
                    <textarea
                      className="input min-h-[72px] text-sm leading-5"
                      disabled={running || !postSetupEnabled || !formFillEnabled}
                      value={formDescription}
                      onChange={(e) => setFormDescription(e.target.value)}
                      placeholder="Mô tả form"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end border-t border-line pt-3">
                <button
                  type="button"
                  className="btn-secondary !py-1.5"
                  disabled={running || savingSetup}
                  onClick={() => void saveSetup()}
                >
                  <Save size={14} />
                  {savingSetup ? 'Đang lưu...' : 'Lưu cấu hình'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Cột phải: trạng thái + hàng đợi + nhật ký */}
        <div className="space-y-4 xl:sticky xl:top-0 xl:self-start">
          <div className="panel space-y-3 p-4">
            <h2 className="font-display text-base font-semibold text-ink">Trạng thái nhóm</h2>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-surface-muted/60 px-2 py-3">
                <div className="text-[11px] uppercase tracking-wide text-ink-muted">Tổng</div>
                <div className="mt-1 font-display text-xl font-semibold text-ink">
                  {groupProfiles.length}
                </div>
              </div>
              <div className="rounded-lg bg-surface-muted/60 px-2 py-3">
                <div className="text-[11px] uppercase tracking-wide text-ink-muted">Đã gắn</div>
                <div className="mt-1 font-display text-xl font-semibold text-ink">{filledCount}</div>
              </div>
              <div className="rounded-lg bg-accent-soft px-2 py-3">
                <div className="text-[11px] uppercase tracking-wide text-accent-strong">Trống</div>
                <div className="mt-1 font-display text-xl font-semibold text-accent-strong">
                  {emptySlots.length}
                </div>
              </div>
            </div>
            <p className="text-xs text-ink-muted">
              Mỗi batch mở tối đa <span className="font-medium text-ink-soft">{safeThreads}</span>{' '}
              Chrome, chia lưới đều. Hết slot trống thì dừng.
            </p>
            {groupProfiles.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line px-3 py-4 text-sm text-ink-muted">
                Nhóm chưa có hồ sơ. Vào{' '}
                <Link className="text-accent underline" to="/profiles">
                  Hồ sơ
                </Link>{' '}
                tạo và gán nhóm.
              </div>
            ) : (
              <ul className="max-h-44 space-y-1 overflow-auto text-sm">
                {groupProfiles.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-line px-2.5 py-1.5"
                  >
                    <span className="truncate text-ink-soft">{p.name}</span>
                    {hasGmailCredentials(p.gmail) ? (
                      <span className="max-w-[55%] truncate font-mono text-[11px] text-accent-strong">
                        {p.gmail?.email}
                      </span>
                    ) : (
                      <span className="shrink-0 text-[11px] text-ink-muted">Trống</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink">
                <ListOrdered size={16} />
                Hàng đợi
              </h2>
              <span className="rounded-md bg-surface-muted px-2 py-0.5 text-[11px] text-ink-muted">
                {availableQueue.length}/{gmailQueue.length} dùng được
              </span>
            </div>
            {gmailQueue.length === 0 ? (
              <div className="text-sm text-ink-muted">Chưa có dòng hợp lệ.</div>
            ) : (
              <ol className="max-h-52 space-y-1 overflow-auto text-sm">
                {gmailQueue.map((item, index) => {
                  const alreadyUsed = usedEmailsGlobal.has(normalizeEmailKey(item.email))
                  const availIndex = alreadyUsed
                    ? -1
                    : availableQueue.findIndex(
                        (g) => normalizeEmailKey(g.email) === normalizeEmailKey(item.email)
                      )
                  const willRun = !alreadyUsed && availIndex >= 0 && availIndex < willUse
                  return (
                    <li
                      key={`${item.email}-${index}`}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5',
                        alreadyUsed
                          ? 'bg-danger/5 opacity-70'
                          : willRun
                            ? 'bg-accent-soft/50'
                            : 'bg-surface-muted/30'
                      )}
                    >
                      <span className="w-5 shrink-0 font-mono text-[11px] text-ink-muted">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
                        {item.email}
                      </span>
                      {alreadyUsed ? (
                        <span className="shrink-0 text-[10px] text-danger">Đã gắn</span>
                      ) : willRun ? (
                        <span className="shrink-0 text-[10px] text-accent-strong">Sẽ dùng</span>
                      ) : (
                        <span className="shrink-0 text-[10px] text-ink-muted">Chờ</span>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>

          <div className="panel p-4">
            <h2 className="mb-3 font-display text-base font-semibold text-ink">Nhật ký</h2>
            {logs.length === 0 ? (
              <div className="text-sm text-ink-muted">Chưa chạy lần nào.</div>
            ) : (
              <ul className="max-h-72 space-y-1 overflow-auto text-xs">
                {logs.map((log) => (
                  <li
                    key={log.id}
                    className={cn(
                      'rounded-md px-2.5 py-1.5 leading-relaxed',
                      log.tone === 'success' && 'bg-success/10 text-success',
                      log.tone === 'error' && 'bg-danger/10 text-danger',
                      log.tone === 'warn' && 'bg-warning/10 text-warning',
                      log.tone === 'info' && 'bg-surface-muted text-ink-soft'
                    )}
                  >
                    {log.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
