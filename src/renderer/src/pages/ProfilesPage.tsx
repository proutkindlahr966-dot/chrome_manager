import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Columns3,
  FolderInput,
  Play,
  Plus,
  Search,
  Square,
  Trash2
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { ProfileFormModal } from '@/components/profiles/ProfileFormModal'
import { ProfileTable } from '@/components/profiles/ProfileTable'
import {
  DEFAULT_VISIBLE_COLUMNS,
  loadVisibleColumns,
  PROFILE_COLUMNS,
  saveVisibleColumns,
  type ProfileColumnId
} from '@/components/profiles/profile-columns'
import { Modal } from '@/components/ui/Modal'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useAppStore } from '@/stores/app-store'
import { askConfirm, toast } from '@/stores/ui-store'
import type { BulkResult, ChromeProfile } from '@shared/types'

export function ProfilesPage(): JSX.Element {
  const profiles = useAppStore((s) => s.profiles)
  const groups = useAppStore((s) => s.groups)
  const filters = useAppStore((s) => s.filters)
  const selectedIds = useAppStore((s) => s.selectedIds)
  const setFilters = useAppStore((s) => s.setFilters)
  const toggleSelect = useAppStore((s) => s.toggleSelect)
  const selectAll = useAppStore((s) => s.selectAll)
  const clearSelection = useAppStore((s) => s.clearSelection)
  const launchProfiles = useAppStore((s) => s.launchProfiles)
  const stopProfiles = useAppStore((s) => s.stopProfiles)
  const deleteProfiles = useAppStore((s) => s.deleteProfiles)
  const resetProfile = useAppStore((s) => s.resetProfile)
  const bulkUpdateProfiles = useAppStore((s) => s.bulkUpdateProfiles)
  const updateGroup = useAppStore((s) => s.updateGroup)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ChromeProfile | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [targetGroupId, setTargetGroupId] = useState('')
  const [searchInput, setSearchInput] = useState(filters.search ?? '')
  const debouncedSearch = useDebouncedValue(searchInput, 300)
  const [visibleColumns, setVisibleColumns] = useState<ProfileColumnId[]>(() => loadVisibleColumns())
  const [columnsOpen, setColumnsOpen] = useState(false)
  const columnsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if ((filters.search ?? '') !== debouncedSearch) {
      setFilters({ search: debouncedSearch })
    }
  }, [debouncedSearch, filters.search, setFilters])

  useEffect(() => {
    if (!columnsOpen) return
    function onDocClick(e: MouseEvent): void {
      if (!columnsRef.current?.contains(e.target as Node)) setColumnsOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setColumnsOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [columnsOpen])

  function toggleColumn(id: ProfileColumnId): void {
    const def = PROFILE_COLUMNS.find((c) => c.id === id)
    if (def?.locked) return
    setVisibleColumns((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      // Không cho tắt hết cột tùy chọn — luôn còn ít nhất name + actions (locked)
      const locked = PROFILE_COLUMNS.filter((c) => c.locked).map((c) => c.id)
      for (const lid of locked) {
        if (!next.includes(lid)) next.push(lid)
      }
      saveVisibleColumns(next)
      return next
    })
  }

  function resetColumns(): void {
    const next = [...DEFAULT_VISIBLE_COLUMNS]
    saveVisibleColumns(next)
    setVisibleColumns(next)
  }

  const selectedList = useMemo(() => [...selectedIds], [selectedIds])

  const hasActiveFilters = useMemo(() => {
    return Boolean(
      (filters.search ?? '').trim() ||
        (filters.groupId && filters.groupId !== 'all') ||
        (filters.status && filters.status !== 'all')
    )
  }, [filters])

  function openCreate(): void {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(profile: ChromeProfile): void {
    setEditing(profile)
    setFormOpen(true)
  }

  function clearFilters(): void {
    setSearchInput('')
    setFilters({ search: '', groupId: 'all', status: 'all' })
  }

  function reportBulkResult(
    action: 'mở' | 'đóng',
    result: BulkResult,
    total: number
  ): void {
    if (result.failed.length === 0) {
      toast({
        tone: 'success',
        title: total === 1 ? `Đã ${action} hồ sơ` : `Đã ${action} ${result.successIds.length} hồ sơ`
      })
      return
    }
    if (result.successIds.length === 0) {
      toast({
        tone: 'error',
        title: `Không thể ${action} hồ sơ`,
        description: result.failed[0]?.error
      })
      return
    }
    toast({
      tone: 'warning',
      title: `${action === 'mở' ? 'Mở' : 'Đóng'} một phần: ${result.successIds.length}/${total}`,
      description: result.failed[0]?.error
    })
  }

  async function handleLaunch(ids: string[]): Promise<void> {
    try {
      const result = await launchProfiles(ids)
      reportBulkResult('mở', result, ids.length)
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không thể mở hồ sơ',
        description: error instanceof Error ? error.message : undefined
      })
    }
  }

  async function handleStop(ids: string[]): Promise<void> {
    try {
      const result = await stopProfiles(ids)
      reportBulkResult('đóng', result, ids.length)
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không thể đóng hồ sơ',
        description: error instanceof Error ? error.message : undefined
      })
    }
  }

  async function confirmDelete(ids: string[]): Promise<void> {
    if (!ids.length) return
    const ok = await askConfirm({
      title: ids.length === 1 ? 'Xóa hồ sơ?' : `Xóa ${ids.length} hồ sơ?`,
      description:
        'Thư mục dữ liệu Chrome của hồ sơ cũng sẽ bị xóa. Thao tác không thể hoàn tác.',
      confirmLabel: 'Xóa',
      danger: true
    })
    if (!ok) return
    await deleteProfiles(ids)
    toast({ tone: 'success', title: ids.length === 1 ? 'Đã xóa hồ sơ' : `Đã xóa ${ids.length} hồ sơ` })
  }

  async function handleWipeProfile(id: string): Promise<void> {
    const profile = profiles.find((p) => p.id === id)
    if (!profile) return
    const mailLine = profile.gmail?.email ? `\nGmail: ${profile.gmail.email}` : ''
    const ok = await askConfirm({
      title: 'Xóa sạch hồ sơ?',
      description: `Hồ sơ "${profile.name}"${mailLine}\n\nSẽ đóng Chrome (nếu đang mở), gỡ Gmail đã gắn và xóa toàn bộ dữ liệu trình duyệt — đưa về trạng thái như hồ sơ mới. Giữ lại tên và nhóm.\n\nThao tác không thể hoàn tác.`,
      confirmLabel: 'Xóa sạch',
      danger: true
    })
    if (!ok) return
    try {
      await resetProfile(id)
      toast({ tone: 'success', title: `Đã xóa sạch "${profile.name}"` })
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'Không thể xóa sạch hồ sơ',
        description: error instanceof Error ? error.message : 'Lỗi không xác định'
      })
    }
  }

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Hồ sơ Chrome"
        description="Tạo, nhóm, khởi chạy và theo dõi hàng loạt các profile trình duyệt."
        actions={
          <button type="button" className="btn-primary" onClick={openCreate}>
            <Plus size={16} />
            Tạo hồ sơ
          </button>
        }
      />

      <div className="mb-4 panel p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted"
            />
            <input
              className="input pl-9"
              placeholder="Tìm theo tên, ghi chú, tag, gmail..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 lg:w-auto lg:shrink-0">
            <select
              className="input"
              value={filters.groupId ?? 'all'}
              onChange={(e) => setFilters({ groupId: e.target.value })}
            >
              <option value="all">Tất cả nhóm</option>
              <option value="ungrouped">Chưa nhóm</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={filters.status ?? 'all'}
              onChange={(e) =>
                setFilters({ status: e.target.value as typeof filters.status })
              }
            >
              <option value="all">Mọi trạng thái</option>
              <option value="idle">Sẵn sàng</option>
              <option value="running">Đang chạy</option>
              <option value="error">Lỗi</option>
            </select>
            <select
              className="input"
              value={filters.sortBy ?? 'name'}
              onChange={(e) =>
                setFilters({ sortBy: e.target.value as typeof filters.sortBy })
              }
            >
              <option value="updatedAt">Sửa gần đây</option>
              <option value="name">Tên</option>
              <option value="createdAt">Ngày tạo</option>
              <option value="lastLaunchedAt">Lần chạy</option>
            </select>
            <select
              className="input"
              value={filters.sortDir ?? 'asc'}
              onChange={(e) =>
                setFilters({ sortDir: e.target.value as typeof filters.sortDir })
              }
            >
              <option value="desc">Giảm dần</option>
              <option value="asc">Tăng dần</option>
            </select>
            <div className="relative col-span-2 sm:col-span-1" ref={columnsRef}>
              <button
                type="button"
                className="btn-secondary w-full justify-center"
                aria-expanded={columnsOpen}
                aria-haspopup="listbox"
                onClick={() => setColumnsOpen((o) => !o)}
              >
                <Columns3 size={15} />
                Cột
                <span className="text-ink-muted">
                  ({visibleColumns.length}/{PROFILE_COLUMNS.length})
                </span>
              </button>
              {columnsOpen ? (
                <div
                  className="absolute right-0 z-20 mt-1.5 w-56 rounded-xl border border-line bg-surface p-2 shadow-lg"
                  role="listbox"
                  aria-label="Chọn cột hiển thị"
                >
                  <div className="mb-1.5 px-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Hiển thị cột
                  </div>
                  <ul className="max-h-72 space-y-0.5 overflow-y-auto">
                    {PROFILE_COLUMNS.map((col) => {
                      const checked = visibleColumns.includes(col.id)
                      return (
                        <li key={col.id}>
                          <label
                            className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-muted ${
                              col.locked ? 'opacity-70' : ''
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="accent-[var(--accent)]"
                              checked={checked}
                              disabled={col.locked}
                              onChange={() => toggleColumn(col.id)}
                            />
                            <span className="flex-1 text-ink">{col.label}</span>
                            {col.locked ? (
                              <span className="text-[10px] uppercase text-ink-muted">cố định</span>
                            ) : null}
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                  <div className="mt-1.5 border-t border-line pt-1.5">
                    <button
                      type="button"
                      className="btn-ghost btn-sm w-full justify-center text-ink-soft"
                      onClick={resetColumns}
                    >
                      Hiện tất cả
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {selectedList.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2.5">
          <span className="mr-1 text-sm font-medium text-accent-strong">
            Đã chọn {selectedList.length}
          </span>
          <div className="h-4 w-px bg-accent/25" />
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => void handleLaunch(selectedList)}
          >
            <Play size={14} />
            Mở
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => void handleStop(selectedList)}
          >
            <Square size={14} />
            Đóng
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => setMoveOpen(true)}
          >
            <FolderInput size={14} />
            Đổi nhóm
          </button>
          <button
            type="button"
            className="btn-danger btn-sm"
            onClick={() => void confirmDelete(selectedList)}
          >
            <Trash2 size={14} />
            Xóa
          </button>
          <button type="button" className="btn-ghost btn-sm ml-auto" onClick={clearSelection}>
            Bỏ chọn
          </button>
        </div>
      ) : null}

      {profiles.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            icon={<Search size={28} />}
            title="Không tìm thấy hồ sơ"
            description="Không có hồ sơ khớp bộ lọc hiện tại. Thử đổi từ khóa hoặc xóa bộ lọc."
            action={
              <button type="button" className="btn-secondary" onClick={clearFilters}>
                Xóa bộ lọc
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={<Plus size={28} />}
            title="Chưa có hồ sơ nào"
            description="Tạo hồ sơ đầu tiên để bắt đầu quản lý phiên Chrome độc lập với proxy và user agent riêng."
            action={
              <button type="button" className="btn-primary" onClick={openCreate}>
                Tạo hồ sơ đầu tiên
              </button>
            }
          />
        )
      ) : (
        <ProfileTable
          profiles={profiles}
          groups={groups}
          selectedIds={selectedIds}
          visibleColumns={visibleColumns}
          onToggle={toggleSelect}
          onSelectAll={() => {
            const allSelected = profiles.every((p) => selectedIds.has(p.id))
            if (allSelected) clearSelection()
            else selectAll(profiles.map((p) => p.id))
          }}
          onLaunch={(id) => void handleLaunch([id])}
          onStop={(id) => void handleStop([id])}
          onWipe={(id) => void handleWipeProfile(id)}
          onToggleRestore={(groupId, enabled) =>
            void updateGroup(groupId, { restoreLastSession: enabled })
          }
          onEdit={openEdit}
          onDelete={(id) => void confirmDelete([id])}
        />
      )}

      <ProfileFormModal
        open={formOpen}
        profile={editing}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
      />

      <Modal
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        title="Chuyển nhóm hàng loạt"
        description={`Cập nhật nhóm cho ${selectedList.length} hồ sơ đã chọn.`}
      >
        <div className="space-y-4">
          <div>
            <label className="label">Nhóm đích</label>
            <select
              className="input"
              value={targetGroupId}
              onChange={(e) => setTargetGroupId(e.target.value)}
            >
              <option value="">Chưa nhóm</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setMoveOpen(false)}>
              Hủy
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={async () => {
                await bulkUpdateProfiles(selectedList, {
                  groupId: targetGroupId || null
                })
                setMoveOpen(false)
                toast({ tone: 'success', title: 'Đã cập nhật nhóm' })
              }}
            >
              Áp dụng
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
