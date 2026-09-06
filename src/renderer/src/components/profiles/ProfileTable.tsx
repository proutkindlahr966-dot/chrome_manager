import {
  Eraser,
  History,
  Pencil,
  Play,
  Square,
  Trash2
} from 'lucide-react'
import type { ChromeProfile, ProfileGroup } from '@shared/types'
import { hasGmailCredentials } from '@shared/gmail'
import { Badge } from '@/components/ui/Badge'
import { Switch } from '@/components/ui/Switch'
import { cn, formatRelative, statusBadgeTone, statusLabel } from '@/lib/utils'

interface ProfileTableProps {
  profiles: ChromeProfile[]
  groups: ProfileGroup[]
  selectedIds: Set<string>
  onToggle: (id: string) => void
  onSelectAll: () => void
  onLaunch: (id: string) => void
  onStop: (id: string) => void
  onClearGmail: (id: string) => void
  onToggleRestore: (groupId: string, enabled: boolean) => void
  onEdit: (profile: ChromeProfile) => void
  onDelete: (id: string) => void
}

export function ProfileTable({
  profiles,
  groups,
  selectedIds,
  onToggle,
  onSelectAll,
  onLaunch,
  onStop,
  onClearGmail,
  onToggleRestore,
  onEdit,
  onDelete
}: ProfileTableProps): JSX.Element {
  const groupMap = new Map(groups.map((g) => [g.id, g]))
  const allSelected = profiles.length > 0 && profiles.every((p) => selectedIds.has(p.id))

  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] table-fixed text-left text-sm">
          <thead className="sticky top-0 z-[1] bg-surface-muted/95 text-xs uppercase tracking-wide text-ink-muted backdrop-blur-sm">
            <tr>
              <th className="w-12 px-3 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={onSelectAll}
                  aria-label="Chọn tất cả"
                />
              </th>
              <th className="w-[18%] px-3 py-3 font-medium">Hồ sơ</th>
              <th className="w-[12%] px-3 py-3 font-medium">Nhóm</th>
              <th className="w-[18%] px-3 py-3 font-medium">Gmail</th>
              <th className="w-[14%] px-3 py-3 font-medium">Proxy</th>
              <th
                className="w-[88px] px-3 py-3 font-medium"
                title="Áp dụng cho cả nhóm — mở lại tab lần chạy trước (mặc định bật)"
              >
                <span className="inline-flex items-center gap-1">
                  <History size={12} />
                  Tab cũ
                </span>
              </th>
              <th className="w-[110px] px-3 py-3 font-medium">Trạng thái</th>
              <th className="w-[120px] px-3 py-3 font-medium">Lần chạy</th>
              <th className="w-[140px] px-3 py-3 font-medium text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => {
              const group = profile.groupId ? groupMap.get(profile.groupId) : null
              const selected = selectedIds.has(profile.id)
              const running = profile.status === 'running'
              const hasGmail = hasGmailCredentials(profile.gmail)
              const restoreLastSession = group ? group.restoreLastSession : true
              const canToggleRestore = Boolean(group)

              return (
                <tr
                  key={profile.id}
                  className={cn(
                    'border-t border-line transition hover:bg-surface-muted/40',
                    selected && 'bg-accent-soft/50'
                  )}
                >
                  <td className="px-3 py-2.5 align-middle">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => onToggle(profile.id)}
                      aria-label={`Chọn ${profile.name}`}
                    />
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <div className="truncate font-medium text-ink" title={profile.name}>
                      {profile.name}
                    </div>
                    <div className="mt-0.5 line-clamp-1 text-xs text-ink-muted">
                      {profile.notes || 'Không có ghi chú'}
                    </div>
                    {profile.tags.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {profile.tags.slice(0, 3).map((tag) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    {group ? (
                      <span className="inline-flex max-w-full items-center gap-2 text-ink-soft">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: group.color }}
                        />
                        <span className="truncate">{group.name}</span>
                      </span>
                    ) : (
                      <span className="text-ink-muted">Chưa nhóm</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    {hasGmail ? (
                      <div className="min-w-0">
                        <div
                          className="truncate font-mono text-xs text-ink-soft"
                          title={profile.gmail?.email}
                        >
                          {profile.gmail?.email}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge tone="accent">Gmail</Badge>
                          {profile.autoLoginGmail ? <Badge>Auto</Badge> : null}
                        </div>
                      </div>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-middle font-mono text-xs text-ink-soft">
                    <span className="block truncate">
                      {profile.proxy.type === 'none'
                        ? '—'
                        : `${profile.proxy.type}://${profile.proxy.host}:${profile.proxy.port ?? ''}`}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <Switch
                      checked={restoreLastSession}
                      disabled={!canToggleRestore}
                      size="sm"
                      label="Tab cũ"
                      title={
                        !canToggleRestore
                          ? 'Chưa nhóm — mặc định bật. Gán nhóm để tắt/bật cho cả nhóm.'
                          : restoreLastSession
                            ? `Đang bật cho nhóm "${group!.name}"`
                            : `Đang tắt cho nhóm "${group!.name}"`
                      }
                      onChange={(next) => {
                        if (!group) return
                        onToggleRestore(group.id, next)
                      }}
                    />
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <Badge tone={statusBadgeTone(profile.status)} dot={running} className="rounded-full">
                      {statusLabel(profile.status)}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 align-middle text-xs text-ink-muted">
                    {formatRelative(profile.lastLaunchedAt)}
                  </td>
                  <td className="px-3 py-2.5 align-middle">
                    <div className="flex items-center justify-end gap-0.5">
                      {running ? (
                        <button
                          type="button"
                          className="btn-ghost btn-icon"
                          title="Đóng"
                          onClick={() => onStop(profile.id)}
                        >
                          <Square size={15} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost btn-icon text-accent"
                          title="Mở"
                          onClick={() => onLaunch(profile.id)}
                        >
                          <Play size={15} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-ghost btn-icon text-danger"
                        title={
                          hasGmail
                            ? `Xóa Gmail đã gắn (${profile.gmail?.email ?? ''})`
                            : 'Chưa có Gmail để xóa'
                        }
                        disabled={!hasGmail}
                        onClick={() => onClearGmail(profile.id)}
                      >
                        <Eraser size={15} />
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-icon"
                        title="Sửa"
                        onClick={() => onEdit(profile)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-icon text-danger"
                        title="Xóa"
                        onClick={() => onDelete(profile.id)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
