import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  FolderKanban,
  Mail,
  Settings,
  Chrome,
  Moon,
  Sun,
  Monitor
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app-store'

const nav = [
  { to: '/', label: 'Tổng quan', icon: LayoutDashboard },
  { to: '/profiles', label: 'Hồ sơ', icon: Users },
  { to: '/groups', label: 'Nhóm', icon: FolderKanban },
  { to: '/gmail', label: 'Gmail', icon: Mail },
  { to: '/settings', label: 'Cài đặt', icon: Settings }
]

interface SidebarProps {
  theme: 'light' | 'dark'
  mode: 'system' | 'light' | 'dark'
  onCycleTheme: () => void
}

function themeLabel(mode: SidebarProps['mode']): string {
  if (mode === 'system') return 'Theo hệ thống'
  if (mode === 'dark') return 'Chế độ tối'
  return 'Chế độ sáng'
}

export function Sidebar({ theme, mode, onCycleTheme }: SidebarProps): JSX.Element {
  const stats = useAppStore((s) => s.stats)

  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-line bg-surface-raised/80 backdrop-blur-sm">
      <div className="border-b border-line px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white dark:text-slate-950">
            <Chrome size={18} />
          </div>
          <div className="min-w-0">
            <div className="truncate font-display text-sm font-semibold tracking-tight text-ink">
              Chrome Manager
            </div>
            <div className="text-2xs text-ink-muted">Profile Control</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-2.5 py-3">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition',
                isActive
                  ? 'bg-accent-soft text-accent-strong'
                  : 'text-ink-soft hover:bg-surface-muted hover:text-ink'
              )
            }
          >
            <item.icon size={16} className="shrink-0" />
            <span className="flex-1 truncate">{item.label}</span>
            {item.to === '/profiles' && stats ? (
              <span className="rounded-md bg-surface-muted px-1.5 py-0.5 text-2xs tabular-nums text-ink-muted">
                {stats.totalProfiles}
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-line p-3">
        <div className="mb-2.5 rounded-xl border border-line bg-surface-muted/60 px-3 py-2.5">
          <div className="text-2xs uppercase tracking-wide text-ink-muted">Đang chạy</div>
          <div className="mt-0.5 font-display text-xl font-semibold tabular-nums text-ink">
            {stats?.runningProfiles ?? 0}
            <span className="ml-1 text-sm font-normal text-ink-muted">
              / {stats?.totalProfiles ?? 0}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="btn-secondary btn-sm w-full"
          title="Chu kỳ: Hệ thống → Sáng → Tối"
          onClick={onCycleTheme}
        >
          {mode === 'system' ? (
            <Monitor size={15} />
          ) : theme === 'dark' ? (
            <Moon size={15} />
          ) : (
            <Sun size={15} />
          )}
          {themeLabel(mode)}
        </button>
      </div>
    </aside>
  )
}
