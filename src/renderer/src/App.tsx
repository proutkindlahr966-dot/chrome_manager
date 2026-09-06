import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AlertCircle, Loader2, X } from 'lucide-react'
import { Sidebar } from '@/components/layout/Sidebar'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ToastHost } from '@/components/ui/ToastHost'
import { DashboardPage } from '@/pages/DashboardPage'
import { ProfilesPage } from '@/pages/ProfilesPage'
import { GroupsPage } from '@/pages/GroupsPage'
import { GmailPage } from '@/pages/GmailPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { useAppStore } from '@/stores/app-store'
import { useTheme } from '@/hooks/useTheme'

export default function App(): JSX.Element {
  const refreshAll = useAppStore((s) => s.refreshAll)
  const applyProfilePatch = useAppStore((s) => s.applyProfilePatch)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const loading = useAppStore((s) => s.loading)
  const error = useAppStore((s) => s.error)
  const clearError = useAppStore((s) => s.clearError)
  const { theme, mode, setMode } = useTheme(settings?.theme ?? 'system')

  useEffect(() => {
    void refreshAll()
    const unsub = window.api.profiles.onStatusChanged((patch) => {
      applyProfilePatch(patch)
    })
    return unsub
  }, [refreshAll, applyProfilePatch])

  useEffect(() => {
    if (settings?.theme) setMode(settings.theme)
  }, [settings?.theme, setMode])

  async function cycleTheme(): Promise<void> {
    const order: Array<'system' | 'light' | 'dark'> = ['system', 'light', 'dark']
    const idx = order.indexOf(mode)
    const next = order[(idx + 1) % order.length]
    setMode(next)
    await updateSettings({ theme: next })
  }

  return (
    <HashRouter>
      <div className="flex h-full min-h-0">
        <Sidebar theme={theme} mode={mode} onCycleTheme={() => void cycleTheme()} />
        <main className="relative min-w-0 flex-1 overflow-auto p-4 md:p-6">
          {loading ? (
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-accent/20">
              <div className="h-full w-1/3 animate-pulse bg-accent" />
            </div>
          ) : null}

          {error ? (
            <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-sm text-danger">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">{error}</div>
              <button
                type="button"
                className="btn-ghost btn-icon text-danger"
                aria-label="Đóng lỗi"
                onClick={clearError}
              >
                <X size={14} />
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => void refreshAll()}
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                Thử lại
              </button>
            </div>
          ) : null}

          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/profiles" element={<ProfilesPage />} />
            <Route path="/groups" element={<GroupsPage />} />
            <Route path="/gmail" element={<GmailPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <ToastHost />
      <ConfirmDialog />
    </HashRouter>
  )
}
