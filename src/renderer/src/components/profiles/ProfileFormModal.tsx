import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Switch } from '@/components/ui/Switch'
import { useAppStore } from '@/stores/app-store'
import type { ChromeProfile, ProxyType } from '@shared/types'
import { DEFAULT_PROXY } from '@shared/types'
import { parseGmailLine, serializeGmail } from '@shared/gmail'
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
  const createProfiles = useAppStore((s) => s.createProfiles)
  const updateProfile = useAppStore((s) => s.updateProfile)
  const settings = useAppStore((s) => s.settings)

  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [groupId, setGroupId] = useState<string>('')
  const [userAgent, setUserAgent] = useState('')
  const [homepage, setHomepage] = useState('chrome://newtab/')
  const [tags, setTags] = useState('')
  const [proxyType, setProxyType] = useState<ProxyType>('none')
  const [proxyHost, setProxyHost] = useState('')
  const [proxyPort, setProxyPort] = useState('')
  const [proxyUser, setProxyUser] = useState('')
  const [proxyPass, setProxyPass] = useState('')
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

  async function resolveAutoName(nextPrefix = DEFAULT_PROFILE_PREFIX): Promise<void> {
    const all = await window.api.profiles.list()
    const next = suggestNextIndex(
      all.map((p) => p.name),
      nextPrefix
    )
    setPrefix(nextPrefix)
    setStartIndex(next)
  }

  useEffect(() => {
    if (!open) return

    setNotes(profile?.notes ?? '')
    setGroupId(profile?.groupId ?? '')
    setUserAgent(profile?.userAgent ?? settings?.defaultUserAgent ?? '')
    setHomepage(profile?.homepage ?? 'chrome://newtab/')
    setTags(profile?.tags.join(', ') ?? '')
    setProxyType(profile?.proxy.type ?? 'none')
    setProxyHost(profile?.proxy.host ?? '')
    setProxyPort(profile?.proxy.port ? String(profile.proxy.port) : '')
    setProxyUser(profile?.proxy.username ?? '')
    setProxyPass(profile?.proxy.password ?? '')
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
      setName(profile.name)
      return
    }

    setName('')
    void resolveAutoName(DEFAULT_PROFILE_PREFIX)
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
      const payload = {
        notes,
        groupId: groupId || null,
        userAgent,
        homepage,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        proxy: {
          ...DEFAULT_PROXY,
          type: proxyType,
          host: proxyHost.trim(),
          port: proxyPort ? Number(proxyPort) : null,
          username: proxyUser,
          password: proxyPass
        },
        gmail: {
          email: gmailEmail.trim(),
          password: gmailPassword,
          recoveryEmail: gmailRecovery.trim(),
          totpSecret: gmailTotp.trim(),
          raw: gmailRaw.trim()
        },
        autoLoginGmail
      }

      if (profile) {
        await updateProfile(profile.id, { ...payload, name: name.trim() })
      } else {
        // Lấy lại số mới nhất trước khi tạo (tránh trùng nếu vừa tạo ở chỗ khác)
        const all = await window.api.profiles.list()
        const next = suggestNextIndex(
          all.map((p) => p.name),
          prefix
        )
        await createProfiles({
          ...payload,
          name: prefix.trim() || DEFAULT_PROFILE_PREFIX,
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
          : 'Tên hồ sơ được lấy tự động theo thứ tự hiện có (Profile 01, 02…).'
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
                  onChange={(e) => setGroupId(e.target.value)}
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
                <span className="font-medium text-ink-soft">{startIndex}</span> (dựa trên hồ sơ
                hiện có)
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
          <div className="mb-3 font-medium text-ink">Proxy</div>
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <label className="label">Loại</label>
              <select
                className="input"
                value={proxyType}
                onChange={(e) => setProxyType(e.target.value as ProxyType)}
              >
                <option value="none">Không dùng</option>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div>
              <label className="label">Host</label>
              <input
                className="input"
                disabled={proxyType === 'none'}
                value={proxyHost}
                onChange={(e) => setProxyHost(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Port</label>
              <input
                className="input"
                disabled={proxyType === 'none'}
                value={proxyPort}
                onChange={(e) => setProxyPort(e.target.value)}
              />
            </div>
            <div>
              <label className="label">User</label>
              <input
                className="input"
                disabled={proxyType === 'none'}
                value={proxyUser}
                onChange={(e) => setProxyUser(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-4">
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              disabled={proxyType === 'none'}
              value={proxyPass}
              onChange={(e) => setProxyPass(e.target.value)}
            />
          </div>
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
