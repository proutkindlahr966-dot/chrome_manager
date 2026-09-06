import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FolderKanban,
  Mail,
  PlayCircle,
  Plus,
  Square,
  Users
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProfileFormModal } from '@/components/profiles/ProfileFormModal'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useAppStore } from '@/stores/app-store'
import { askConfirm, toast } from '@/stores/ui-store'
import { formatRelative, statusBadgeTone, statusLabel, cn } from '@/lib/utils'

export function DashboardPage(): JSX.Element {
  const stats = useAppStore((s) => s.stats)
  const groups = useAppStore((s) => s.groups)
  const loading = useAppStore((s) => s.loading)
  const stopProfiles = useAppStore((s) => s.stopProfiles)
  const [createOpen, setCreateOpen] = useState(false)
  const [stoppingAll, setStoppingAll] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)

  const bootstrapping = loading && !stats
  const attentionCount = (stats?.errorProfiles ?? 0) + (stats?.startingOrStopping ?? 0)

  const cards = useMemo(() => {
    const total = stats?.totalProfiles ?? 0
    const running = stats?.runningProfiles ?? 0
    const withGmail = stats?.withGmail ?? 0
    return [
      {
        label: 'Tổng hồ sơ',
        value: String(total),
        hint: `${stats?.totalGroups ?? 0} nhóm · ${stats?.withProxy ?? 0} có proxy`,
        icon: Users,
        tone: 'text-ink'
      },
      {
        label: 'Đang chạy',
        value: String(running),
        hint: total ? `${running}/${total} phiên Chrome` : 'Chưa có hồ sơ',
        icon: PlayCircle,
        tone: running > 0 ? 'text-success' : 'text-ink'
      },
      {
        label: 'Đã gắn Gmail',
        value: String(withGmail),
        hint: total
          ? `${withGmail}/${total} · còn ${stats?.withoutGmail ?? 0} trống`
          : 'Chưa gắn mail',
        icon: Mail,
        tone: withGmail > 0 ? 'text-accent' : 'text-ink'
      },
      {
        label: attentionCount > 0 ? 'Cần chú ý' : 'Trạng thái',
        value: attentionCount > 0 ? String(attentionCount) : 'Ổn định',
        hint:
          attentionCount > 0
            ? `${stats?.errorProfiles ?? 0} lỗi · ${stats?.startingOrStopping ?? 0} đang mở/đóng`
            : `${stats?.idleProfiles ?? 0} sẵn sàng`,
        icon: attentionCount > 0 ? AlertTriangle : CheckCircle2,
        tone: attentionCount > 0 ? 'text-warning' : 'text-success'
      }
    ]
  }, [stats, attentionCount])

  async function stopAllRunning(): Promise<void> {
    const all = await window.api.profiles.list({ status: 'all', groupId: 'all' })
    const targets = all
      .filter((p) => p.status === 'running' || p.status === 'starting')
      .map((p) => p.id)
    if (targets.length === 0) return

    const ok = await askConfirm({
      title: `Dừng ${targets.length} hồ sơ đang chạy?`,
      description: 'Các cửa sổ Chrome tương ứng sẽ được đóng.',
      confirmLabel: 'Dừng tất cả',
      danger: true
    })
    if (!ok) return

    setStoppingAll(true)
    try {
      const result = await stopProfiles(targets)
      if (result.failed.length === 0) {
        toast({ tone: 'success', title: `Đã dừng ${result.successIds.length} hồ sơ` })
      } else {
        toast({
          tone: 'warning',
          title: `Dừng một phần: ${result.successIds.length}/${targets.length}`,
          description: result.failed[0]?.error
        })
      }
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không thể dừng hồ sơ',
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setStoppingAll(false)
    }
  }

  async function stopOne(id: string): Promise<void> {
    setStoppingId(id)
    try {
      const result = await stopProfiles([id])
      if (result.failed.length > 0) {
        toast({
          tone: 'error',
          title: 'Không thể dừng hồ sơ',
          description: result.failed[0]?.error
        })
      } else {
        toast({ tone: 'success', title: 'Đã dừng hồ sơ' })
      }
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không thể dừng hồ sơ',
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setStoppingId(null)
    }
  }

  function groupNameOf(groupId: string | null): string {
    if (!groupId) return 'Chưa nhóm'
    return groups.find((g) => g.id === groupId)?.name ?? 'Không rõ'
  }

  function groupColorOf(groupId: string | null): string {
    if (!groupId) return 'rgb(100 116 139)'
    return groups.find((g) => g.id === groupId)?.color ?? 'rgb(100 116 139)'
  }

  const runningCount = stats?.runningProfiles ?? 0

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Tổng quan"
        description="Theo dõi hồ sơ Chrome, Gmail đã gắn và truy cập nhanh thao tác thường dùng."
        actions={
          <>
            <Link to="/profiles" className="btn-secondary">
              Xem hồ sơ
            </Link>
            <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} />
              Tạo hồ sơ
            </button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="panel p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-ink-muted">{card.label}</div>
                {bootstrapping ? (
                  <div className="mt-2 h-9 w-20 animate-pulse rounded-md bg-surface-muted" />
                ) : (
                  <div
                    className={cn(
                      'mt-2 font-display text-3xl font-semibold tabular-nums',
                      card.tone
                    )}
                  >
                    {card.value}
                  </div>
                )}
                <div className="mt-1 text-xs text-ink-muted">
                  {bootstrapping ? 'Đang tải...' : card.hint}
                </div>
              </div>
              <div className="shrink-0 rounded-lg bg-accent-soft p-2 text-accent">
                <card.icon size={18} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link to="/gmail" className="btn-secondary">
          <Mail size={15} />
          Login Gmail
        </Link>
        <Link to="/groups" className="btn-secondary">
          <FolderKanban size={15} />
          Quản lý nhóm
        </Link>
        <Link to="/profiles" className="btn-secondary">
          <Users size={15} />
          Hồ sơ
        </Link>
        {runningCount > 0 ? (
          <button
            type="button"
            className="btn-danger"
            disabled={stoppingAll}
            onClick={() => void stopAllRunning()}
          >
            <Square size={15} />
            {stoppingAll ? 'Đang dừng...' : `Dừng tất cả (${runningCount})`}
          </button>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-5">
        <div className="panel p-4 lg:col-span-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-display text-base font-semibold text-ink">Chạy gần đây</h2>
            <Link to="/profiles" className="text-sm text-accent hover:underline">
              Quản lý
            </Link>
          </div>
          <div className="space-y-2">
            {bootstrapping ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-14 animate-pulse rounded-lg border border-line bg-surface-muted/40"
                  />
                ))}
              </div>
            ) : (stats?.recentlyLaunched ?? []).length === 0 ? (
              <EmptyState
                className="py-10"
                title="Chưa có lần chạy nào"
                description="Mở một hồ sơ từ trang Hồ sơ để theo dõi tại đây."
                action={
                  <Link to="/profiles" className="btn-secondary btn-sm">
                    Đi tới Hồ sơ
                  </Link>
                }
              />
            ) : (
              stats?.recentlyLaunched.map((profile) => {
                const canStop = profile.status === 'running' || profile.status === 'starting'
                return (
                  <div
                    key={profile.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-muted/30 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">{profile.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: groupColorOf(profile.groupId) }}
                          />
                          {groupNameOf(profile.groupId)}
                        </span>
                        {profile.gmail?.email ? (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate">{profile.gmail.email}</span>
                          </>
                        ) : null}
                        <span aria-hidden>·</span>
                        <span>{formatRelative(profile.lastLaunchedAt)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge
                        tone={statusBadgeTone(profile.status)}
                        dot={profile.status === 'running'}
                        className="rounded-full"
                      >
                        {statusLabel(profile.status)}
                      </Badge>
                      {canStop ? (
                        <button
                          type="button"
                          className="btn-ghost btn-icon text-danger"
                          title="Dừng hồ sơ"
                          disabled={stoppingId === profile.id || stoppingAll}
                          onClick={() => void stopOne(profile.id)}
                        >
                          <Square size={14} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="panel p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-display text-base font-semibold text-ink">Phân bố theo nhóm</h2>
            <Link to="/groups" className="text-sm text-accent hover:underline">
              Nhóm
            </Link>
          </div>
          <div className="space-y-3">
            {bootstrapping ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded-md bg-surface-muted/50" />
                ))}
              </div>
            ) : (stats?.groupBreakdown ?? []).length === 0 ? (
              <EmptyState
                className="py-8"
                title="Chưa có dữ liệu nhóm"
                description="Tạo nhóm và gán hồ sơ để xem phân bố tại đây."
                action={
                  <Link to="/groups" className="btn-secondary btn-sm">
                    Quản lý nhóm
                  </Link>
                }
              />
            ) : (
              stats?.groupBreakdown.map((item) => {
                const group = groups.find((g) => g.id === item.groupId)
                const pct = stats.totalProfiles
                  ? Math.round((item.count / stats.totalProfiles) * 100)
                  : 0
                const gmailPct = item.count
                  ? Math.round((item.withGmail / item.count) * 100)
                  : 0
                return (
                  <div key={`${item.groupId ?? 'none'}-${item.groupName}`}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                      <span className="inline-flex min-w-0 items-center gap-2 text-ink-soft">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: group?.color ?? 'rgb(100 116 139)' }}
                        />
                        <span className="truncate">{item.groupName}</span>
                      </span>
                      <span className="shrink-0 text-ink-muted">
                        {item.count} · {pct}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-1 text-2xs text-ink-muted">
                      Gmail {item.withGmail}/{item.count}
                      {item.count > 0 ? ` · ${gmailPct}% đã gắn` : ''}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      <ProfileFormModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  )
}
