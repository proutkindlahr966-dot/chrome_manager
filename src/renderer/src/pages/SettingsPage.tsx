import { FormEvent, useEffect, useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Switch } from '@/components/ui/Switch'
import { useAppStore } from '@/stores/app-store'
import { toast } from '@/stores/ui-store'
import type { AppSettings } from '@shared/types'

export function SettingsPage(): JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const detectChrome = useAppStore((s) => s.detectChrome)

  const [form, setForm] = useState<AppSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [detecting, setDetecting] = useState(false)

  useEffect(() => {
    if (settings) setForm(settings)
  }, [settings])

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!form) return
    setSaving(true)
    try {
      await updateSettings(form)
      toast({ tone: 'success', title: 'Đã lưu cài đặt' })
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không thể lưu',
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setSaving(false)
    }
  }

  async function onThemeChange(theme: AppSettings['theme']): Promise<void> {
    if (!form) return
    setForm({ ...form, theme })
    await updateSettings({ theme })
  }

  async function onDetectChrome(): Promise<void> {
    setDetecting(true)
    try {
      const path = await detectChrome()
      if (path) {
        setForm((prev) => (prev ? { ...prev, chromePath: path } : prev))
        toast({ tone: 'success', title: 'Đã phát hiện Chrome', description: path })
      } else {
        toast({ tone: 'warning', title: 'Không tìm thấy Chrome trên máy' })
      }
    } finally {
      setDetecting(false)
    }
  }

  if (!form) {
    return (
      <div className="animate-fade-up max-w-3xl space-y-4">
        <PageHeader
          title="Cài đặt"
          description="Cấu hình đường dẫn Chrome, thư mục dữ liệu hồ sơ và hành vi ứng dụng."
        />
        <div className="panel space-y-4 p-5">
          <div className="h-10 animate-pulse rounded-lg bg-surface-muted" />
          <div className="h-10 animate-pulse rounded-lg bg-surface-muted" />
          <div className="h-20 animate-pulse rounded-lg bg-surface-muted" />
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-up max-w-3xl">
      <PageHeader
        title="Cài đặt"
        description="Cấu hình đường dẫn Chrome, thư mục dữ liệu hồ sơ và hành vi ứng dụng."
      />

      <form className="panel space-y-5 p-5" onSubmit={(e) => void onSubmit(e)}>
        <div>
          <label className="label">Đường dẫn Chrome</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="input min-w-0 font-mono text-xs"
              value={form.chromePath}
              onChange={(e) => setForm({ ...form, chromePath: e.target.value })}
              placeholder="C:\Program Files\Google\Chrome\Application\chrome.exe"
            />
            <button
              type="button"
              className="btn-secondary shrink-0"
              disabled={detecting}
              onClick={() => void onDetectChrome()}
            >
              {detecting ? 'Đang tìm...' : 'Tự động tìm'}
            </button>
          </div>
        </div>

        <div>
          <label className="label">Thư mục gốc dữ liệu hồ sơ</label>
          <input
            className="input font-mono text-xs"
            value={form.profilesRoot}
            onChange={(e) => setForm({ ...form, profilesRoot: e.target.value })}
          />
        </div>

        <div>
          <label className="label">User Agent mặc định</label>
          <textarea
            className="input min-h-[88px] font-mono text-xs"
            value={form.defaultUserAgent}
            onChange={(e) => setForm({ ...form, defaultUserAgent: e.target.value })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Giao diện</label>
            <select
              className="input"
              value={form.theme}
              onChange={(e) => void onThemeChange(e.target.value as AppSettings['theme'])}
            >
              <option value="system">Theo hệ thống</option>
              <option value="light">Sáng</option>
              <option value="dark">Tối</option>
            </select>
          </div>
          <div>
            <label className="label">Số hồ sơ mở đồng thời tối đa</label>
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={form.maxConcurrentLaunches}
              onChange={(e) =>
                setForm({ ...form, maxConcurrentLaunches: Number(e.target.value) || 1 })
              }
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted/40 px-4 py-3">
          <div className="min-w-0 text-sm text-ink-soft">
            <div className="font-medium text-ink">Đóng hồ sơ khi thoát app</div>
            <div className="mt-0.5 text-xs text-ink-muted">
              Tự động đóng tất cả cửa sổ Chrome do app mở khi thoát.
            </div>
          </div>
          <Switch
            checked={form.closeOnExit}
            label="Đóng hồ sơ khi thoát app"
            onChange={(checked) => setForm({ ...form, closeOnExit: checked })}
          />
        </div>

        <div className="flex justify-end">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Đang lưu...' : 'Lưu cài đặt'}
          </button>
        </div>
      </form>
    </div>
  )
}
