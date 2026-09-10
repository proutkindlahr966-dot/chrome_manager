import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Switch } from '@/components/ui/Switch'
import { useAppStore } from '@/stores/app-store'
import type { ChromeProfile, ProxyType } from '@shared/types'
import { DEFAULT_PROXY } from '@shared/types'
import { parseGmailLine, serializeGmail } from '@shared/gmail'
import { parseProxyList, parseProxyString, serializeProxy } from '@shared/proxy'
import {
  DEFAULT_PROFILE_PREFIX,
  formatProfileName,
  suggestNextIndex
} from '@/lib/utils'

interface ProfileFormModalProps {
  open: boolean
  profile?: ChromeProfile | null
  onClose: () => void
}

export function ProfileFormModal({ open, profile, onClose }: ProfileFormModalProps): JSX.Element {
  const groups = useAppStore((s) => s.groups)
  const filters = useAppStore((s) => s.filters)
  const createProfiles = useAppStore((s) => s.createProfiles)
  const updateProfile = useAppStore((s) => s.updateProfile)
  const settings = useAppStore((s) => s.settings)

  function prefixForGroup(id: string): string {
    if (!id) return DEFAULT_PROFILE_PREFIX
    return groups.find((g) => g.id === id)?.name.trim() || DEFAULT_PROFILE_PREFIX
  }

  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [groupId, setGroupId] = useState<string>('')
  const [userAgent, setUserAgent] = useState('')
  const [homepage, setHomepage] = useState('chrome://newtab/')
  const [tags, setTags] = useState('')
  const [proxyType, setProxyType] = useState<ProxyType>('none')
  const [proxyRaw, setProxyRaw] = useState('')
  const [count, setCount] = useState(1)
  const [startIndex, setStartIndex] = useState(1)
  const [prefix, setPrefix] = useState(DEFAULT_PROFILE_PREFIX)
  const [gmailRaw, setGmailRaw] = useState('')
  const [gmailEmail, setGmailEmail] = useState('')
  const [gmailPassword, setGmailPassword] = useState('')
  const [gmailRecovery, setGmailRecovery] = useState('')
  const [gmailTotp, setGmailTotp] = useState('')
  const [autoLoginGmail, setAutoLoginGmail] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function applyGmailRaw(raw: string): void {
    setGmailRaw(raw)
    const parsed = parseGmailLine(raw)
    setGmailEmail(parsed.email)
    setGmailPassword(parsed.password)
    setGmailRecovery(parsed.recoveryEmail)
    setGmailTotp(parsed.totpSecret)
  }

  function syncGmailRawFromFields(
    email: string,
    password: string,
    recovery: string,
    totp: string
  ): void {
    setGmailRaw(
      serializeGmail({
        email,
        password,
        recoveryEmail: recovery,
        totpSecret: totp
      })
    )
  }

  const isEdit = Boolean(profile)

  const safeCount = Math.min(500, Math.max(1, Math.floor(count) || 1))
  const pad = Math.max(2, String(startIndex + safeCount - 1).length)

  const previewNames = useMemo(() => {
    if (isEdit) return []
    const samples = Array.from({ length: Math.min(3, safeCount) }, (_, i) =>
      formatProfileName(prefix, startIndex + i, pad)
    )
    if (safeCount > 3) {
      samples.push(`… ${formatProfileName(prefix, startIndex + safeCount - 1, pad)}`)
    }
    return samples
  }, [isEdit, safeCount, startIndex, prefix, pad])

  const proxyLines = useMemo(
    () => parseProxyList(proxyRaw, proxyType === 'none' ? 'http' : proxyType),
    [proxyRaw, proxyType]
  )

  async function resolveAutoName(nextGroupId: string): Promise<void> {
    const nextPrefix = prefixForGroup(nextGroupId)
    const all = await window.api.profiles.list()
    // Đánh số theo từng nhóm: chỉ xét hồ sơ cùng nhóm (hoặc chưa nhóm)
    const scoped = all.filter((p) =>
      nextGroupId ? p.groupId === nextGroupId : !p.groupId
    )
    const next = suggestNextIndex(
      scoped.map((p) => p.name),
      nextPrefix
    )
    setPrefix(nextPrefix)
    setStartIndex(next)
  }

  useEffect(() => {
    if (!open) return

    setNotes(profile?.notes ?? '')
    setUserAgent(profile?.userAgent ?? settings?.defaultUserAgent ?? '')
    setHomepage(profile?.homepage ?? 'chrome://newtab/')
    setTags(profile?.tags.join(', ') ?? '')
    setProxyType(profile?.proxy.type ?? 'none')
    setProxyRaw(profile?.proxy ? serializeProxy(profile.proxy) : '')
    setCount(1)
    setError(null)

    const g = profile?.gmail
    setGmailEmail(g?.email ?? '')
    setGmailPassword(g?.password ?? '')
    setGmailRecovery(g?.recoveryEmail ?? '')
    setGmailTotp(g?.totpSecret ?? '')
    setGmailRaw(g ? serializeGmail(g) : '')
    setAutoLoginGmail(Boolean(profile?.autoLoginGmail))

    if (profile) {
      setGroupId(profile.groupId ?? '')
      setName(profile.name)
      return
    }

    // Tạo mới: ưu tiên nhóm đang lọc trên danh sách
    const initialGroupId =
      filters.groupId && filters.groupId !== 'all' ? filters.groupId : ''
    setGroupId(initialGroupId)
    setName('')
    void resolveAutoName(initialGroupId)
  }, [open, profile, settings])

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()

    if (isEdit && !name.trim()) {
      setError('Vui lòng nhập tên hồ sơ')
      return
    }

    setSaving(true)
    setError(null)
    try {
      if (profile) {
        // Sửa 1 hồ sơ: lấy dòng proxy đầu tiên hợp lệ
        let proxy = { ...DEFAULT_PROXY }
        if (proxyType !== 'none' && proxyRaw.trim()) {
          const parsed =
            proxyLines[0] ??
            parseProxyString(
              proxyRaw
                .split(/\r?\n/)
                .map((l) => l.trim())
                .find(Boolean) ?? '',
              proxyType
            )
          if (!parsed.host || !parsed.port) {
            setError('Proxy không hợp lệ. Dùng dạng host:port:user:pass')
            setSaving(false)
            return
          }
          proxy = { ...parsed, type: proxyType }
        }

        await updateProfile(profile.id, {
          name: name.trim(),
          notes,
          groupId: groupId || null,
          userAgent,
          homepage,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          proxy,
          gmail: {
            email: gmailEmail.trim(),
            password: gmailPassword,
            recoveryEmail: gmailRecovery.trim(),
            totpSecret: gmailTotp.trim(),
            raw: gmailRaw.trim()
          },
          autoLoginGmail
        })
      } else {
        const useProxyList = proxyType !== 'none' && proxyLines.length > 0
        if (proxyType !== 'none' && proxyRaw.trim() && proxyLines.length === 0) {
          setError('Danh sách proxy không hợp lệ. Mỗi dòng: host:port:user:pass')
          setSaving(false)
          return
        }

        const nextPrefix = prefixForGroup(groupId)
        const all = await window.api.profiles.list()
        const scoped = all.filter((p) =>
          groupId ? p.groupId === groupId : !p.groupId
        )
        const next = suggestNextIndex(
          scoped.map((p) => p.name),
          nextPrefix
        )
        await createProfiles({
          name: nextPrefix,
          notes,
          groupId: groupId || null,
          userAgent,
          homepage,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          proxy: useProxyList ? proxyLines[0] : undefined,
          proxyList: useProxyList ? proxyLines : undefined,
          gmail: {
            email: gmailEmail.trim(),
            password: gmailPassword,
            recoveryEmail: gmailRecovery.trim(),
            totpSecret: gmailTotp.trim(),
            raw: gmailRaw.trim()
          },
          autoLoginGmail,
          count: safeCount,
          startIndex: next
        })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể lưu hồ sơ')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={profile ? 'Chỉnh sửa hồ sơ' : 'Tạo hồ sơ mới'}
      description={
        profile
          ? 'Cập nhật thông tin vận hành cho hồ sơ Chrome.'
          : 'Tên hồ sơ tự động theo từng nhóm (tên nhóm 01, 02…).'
      }
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        {isEdit ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="label">Tên hồ sơ</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="label">Nhóm</label>
              <select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Chưa nhóm</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="label">Số lượng</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={500}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value) || 1)}
                />
              </div>
              <div>
                <label className="label">Nhóm</label>
                <select
                  className="input"
                  value={groupId}
                  onChange={(e) => {
                    const nextId = e.target.value
                    setGroupId(nextId)
                    void resolveAutoName(nextId)
                  }}
                >
                  <option value="">Chưa nhóm</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rounded-xl border border-line bg-surface-muted/40 p-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
                Tên tự động
              </div>
              <div className="font-mono text-sm text-ink">
                {previewNames.join(' · ') || formatProfileName(prefix, startIndex, pad)}
              </div>
              <div className="mt-2 text-xs text-ink-muted">
                Tiền tố <span className="font-medium text-ink-soft">{prefix}</span>, bắt đầu từ{' '}
                <span className="font-medium text-ink-soft">{startIndex}</span> (theo hồ sơ trong
                nhóm)
              </div>
            </div>
          </>
        )}

        {/* Ngay dưới Nhóm — dễ thấy khi mở form */}
        <div className="rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
          <div className="mb-3 font-medium text-ink">Gmail (tự động đăng nhập)</div>
          <div className="mb-3">
            <label className="label">Dán nhanh (mail|pass|mã 2fa 6 số)</label>
            <input
              className="input font-mono text-xs"
              value={gmailRaw}
              onChange={(e) => applyGmailRaw(e.target.value)}
              placeholder="user@gmail.com|password|123456"
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="label">Email</label>
              <input
                className="input"
                value={gmailEmail}
                onChange={(e) => {
                  setGmailEmail(e.target.value)
                  syncGmailRawFromFields(e.target.value, gmailPassword, gmailRecovery, gmailTotp)
                }}
              />
            </div>
            <div>
              <label className="label">Mật khẩu</label>
              <input
                className="input"
                type="password"
                value={gmailPassword}
                onChange={(e) => {
                  setGmailPassword(e.target.value)
                  syncGmailRawFromFields(gmailEmail, e.target.value, gmailRecovery, gmailTotp)
                }}
              />
            </div>
            <div>
              <label className="label">Email khôi phục</label>
              <input
                className="input"
                value={gmailRecovery}
                onChange={(e) => {
                  setGmailRecovery(e.target.value)
                  syncGmailRawFromFields(gmailEmail, gmailPassword, e.target.value, gmailTotp)
                }}
              />
            </div>
            <div>
              <label className="label">Mã 2FA (6 số)</label>
              <input
                className="input font-mono text-xs"
                value={gmailTotp}
                onChange={(e) => {
                  setGmailTotp(e.target.value)
                  syncGmailRawFromFields(gmailEmail, gmailPassword, gmailRecovery, e.target.value)
                }}
                placeholder="123456"
              />
            </div>
          </div>
          <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-line bg-surface-muted/30 px-3 py-2.5">
            <div className="min-w-0 text-sm text-ink-soft">
              <div className="font-medium text-ink">Gắn cờ Auto-login Gmail</div>
              <div className="mt-0.5 text-xs text-ink-muted">
                Dùng cho luồng Login Gmail / đổ Gmail. Mở hồ sơ bình thường không tự vào inbox.
              </div>
            </div>
            <Switch
              checked={autoLoginGmail}
              label="Auto-login Gmail"
              onChange={setAutoLoginGmail}
            />
          </div>
        </div>

        <div>
          <label className="label">Ghi chú</label>
          <textarea
            className="input min-h-[80px] resize-y"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label">Trang khởi đầu</label>
            <input
              className="input"
              value={homepage}
              onChange={(e) => setHomepage(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div>
            <label className="label">Tags (phân tách bằng dấu phẩy)</label>
            <input
              className="input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="work, test, client-a"
            />
          </div>
        </div>

        <div>
          <label className="label">User Agent</label>
          <input
            className="input font-mono text-xs"
            value={userAgent}
            onChange={(e) => setUserAgent(e.target.value)}
          />
        </div>

        <div className="rounded-xl border border-line bg-surface-muted/40 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="font-medium text-ink">
              Danh sách proxy ({proxyLines.length})
            </div>
            <select
              className="input !w-auto !py-1.5"
              value={proxyType === 'none' && proxyLines.length > 0 ? 'http' : proxyType}
              onChange={(e) => setProxyType(e.target.value as ProxyType)}
              aria-label="Loại proxy"
            >
              <option value="none">Không dùng</option>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </div>
          <textarea
            className="input min-h-[120px] font-mono text-xs leading-5"
            value={proxyRaw}
            onChange={(e) => {
              const next = e.target.value
              setProxyRaw(next)
              const first = next
                .split(/\r?\n/)
                .map((l) => l.trim())
                .find(Boolean)
              if (!first) {
                setProxyType('none')
                return
              }
              const m = first.match(/^(https?|socks5):\/\//i)
              if (m) {
                setProxyType(m[1].toLowerCase() as ProxyType)
              } else if (proxyType === 'none') {
                setProxyType('http')
              }
            }}
            placeholder={
              isEdit
                ? '180.149.35.219:29383:lgjXCh:kHbkUw'
                : '14.190.207.188:27622:Uuyhsg:KBiiRY\n180.149.35.219:29383:lgjXCh:kHbkUw'
            }
          />
          <p className="mt-1.5 text-xs text-ink-muted">
            Mỗi dòng: <span className="font-mono">host:port:user:pass</span>
            {!isEdit
              ? ' — khi tạo nhiều hồ sơ, hồ sơ thứ 1 lấy dòng 1, thứ 2 lấy dòng 2…'
              : null}
            {!isEdit && proxyLines.length > 0 && safeCount !== proxyLines.length ? (
              <>
                {' '}
                (đang tạo {safeCount} hồ sơ · {proxyLines.length} proxy
                {safeCount > proxyLines.length
                  ? ` · ${safeCount - proxyLines.length} hồ sơ cuối không có proxy`
                  : ` · dùng ${safeCount}/${proxyLines.length} dòng`}
                )
              </>
            ) : null}
          </p>
        </div>

        {profile ? (
          <div className="rounded-lg border border-line bg-surface-muted/50 px-3 py-2 text-xs text-ink-muted">
            Thư mục dữ liệu: <span className="font-mono text-ink-soft">{profile.dataDir}</span>
          </div>
        ) : null}

        {error ? <div className="text-sm text-danger">{error}</div> : null}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Hủy
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving
              ? profile
                ? 'Đang lưu...'
                : 'Đang tạo...'
              : profile
                ? 'Cập nhật'
                : safeCount > 1
                  ? `Tạo ${safeCount} hồ sơ`
                  : 'Tạo hồ sơ'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
