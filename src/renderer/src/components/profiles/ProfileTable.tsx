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
import { isColumnVisible, type ProfileColumnId } from './profile-columns'

interface ProfileTableProps {
  profiles: ChromeProfile[]
  groups: ProfileGroup[]
  selectedIds: Set<string>
  visibleColumns: ProfileColumnId[]
  onToggle: (id: string) => void
  onSelectAll: () => void
  onLaunch: (id: string) => void
  onStop: (id: string) => void
  onWipe: (id: string) => void
  onToggleRestore: (groupId: string, enabled: boolean) => void
  onEdit: (profile: ChromeProfile) => void
  onDelete: (id: string) => void
}

export function ProfileTable({
  profiles,
  groups,
  selectedIds,
  visibleColumns,
  onToggle,
  onSelectAll,
  onLaunch,
  onStop,
  onWipe,
  onToggleRestore,
  onEdit,
  onDelete
}: ProfileTableProps): JSX.Element {
  const groupMap = new Map(groups.map((g) => [g.id, g]))
  const allSelected = profiles.length > 0 && profiles.every((p) => selectedIds.has(p.id))
  const show = (id: ProfileColumnId): boolean => isColumnVisible(visibleColumns, id)
  const colCount =
    1 + // checkbox
    (show('name') ? 1 : 0) +
    (show('group') ? 1 : 0) +
    (show('gmail') ? 1 : 0) +
    (show('proxy') ? 1 : 0) +
    (show('restore') ? 1 : 0) +
    (show('status') ? 1 : 0) +
    (show('lastLaunched') ? 1 : 0) +
    (show('actions') ? 1 : 0)

  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table
          className="w-full table-fixed text-left text-sm"
          style={{ minWidth: Math.max(640, colCount * 110) }}
        >
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
              {show('name') ? <th className="w-[18%] px-3 py-3 font-medium">Hồ sơ</th> : null}
              {show('group') ? <th className="w-[12%] px-3 py-3 font-medium">Nhóm</th> : null}
              {show('gmail') ? <th className="w-[18%] px-3 py-3 font-medium">Gmail</th> : null}
              {show('proxy') ? <th className="w-[14%] px-3 py-3 font-medium">Proxy</th> : null}
              {show('restore') ? (
                <th
                  className="w-[88px] px-3 py-3 font-medium"
                  title="Áp dụng cho cả nhóm — mở lại tab lần chạy trước (mặc định bật)"
                >
                  <span className="inline-flex items-center gap-1">
                    <History size={12} />
                    Tab cũ
                  </span>
                </th>
              ) : null}
              {show('status') ? (
                <th className="w-[110px] px-3 py-3 font-medium">Trạng thái</th>
              ) : null}
              {show('lastLaunched') ? (
                <th className="w-[120px] px-3 py-3 font-medium">Lần chạy</th>
              ) : null}
              {show('actions') ? (
                <th className="w-[140px] px-3 py-3 font-medium text-right">Thao tác</th>
              ) : null}
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
                  {show('name') ? (
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
                  ) : null}
                  {show('group') ? (
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
                  ) : null}
                  {show('gmail') ? (
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
                  ) : null}
                  {show('proxy') ? (
                    <td className="px-3 py-2.5 align-middle font-mono text-xs text-ink-soft">
                      <span className="block truncate">
                        {profile.proxy.type === 'none'
                          ? '—'
                          : `${profile.proxy.type}://${profile.proxy.host}:${profile.proxy.port ?? ''}`}
                      </span>
                    </td>
                  ) : null}
                  {show('restore') ? (
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
                  ) : null}
                  {show('status') ? (
                    <td className="px-3 py-2.5 align-middle">
                      <Badge
                        tone={statusBadgeTone(profile.status)}
                        dot={running}
                        className="rounded-full"
                      >
                        {statusLabel(profile.status)}
                      </Badge>
                    </td>
                  ) : null}
                  {show('lastLaunched') ? (
                    <td className="whitespace-nowrap px-3 py-2.5 align-middle text-xs text-ink-muted">
                      {formatRelative(profile.lastLaunchedAt)}
                    </td>
                  ) : null}
                  {show('actions') ? (
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
                          title="Xóa sạch hồ sơ (Gmail + dữ liệu Chrome → như mới)"
                          onClick={() => onWipe(profile.id)}
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
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
