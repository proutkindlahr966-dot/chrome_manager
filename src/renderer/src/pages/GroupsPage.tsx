import { FormEvent, useMemo, useState } from 'react'
import { Download, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import { Switch } from '@/components/ui/Switch'
import { useAppStore } from '@/stores/app-store'
import { askConfirm, toast } from '@/stores/ui-store'
import { GROUP_COLORS, type ProfileGroup } from '@shared/types'
import {
  parseImportGroupsJson,
  summarizeImportPayload
} from '@shared/group-import'
import type { DataImportPreview } from '@shared/data-import'
import {
  DEFAULT_PROFILE_PREFIX,
  formatDate,
  formatProfileName,
  suggestNextIndex
} from '@/lib/utils'

const IMPORT_EXAMPLE = `{
  "version": 1,
  "groups": [
    {
      "name": "Dự án A",
      "color": "#0F766E",
      "description": "",
      "restoreLastSession": true,
      "profiles": [
        {
          "name": "Dự án A 01",
          "proxy": "host:port:user:pass",
          "gmail": "mail@gmail.com|password|2fasecret"
        }
      ]
    }
  ]
}`

export function GroupsPage(): JSX.Element {
  const groups = useAppStore((s) => s.groups)
  const profiles = useAppStore((s) => s.profiles)
  const createGroup = useAppStore((s) => s.createGroup)
  const createProfiles = useAppStore((s) => s.createProfiles)
  const updateGroup = useAppStore((s) => s.updateGroup)
  const deleteGroup = useAppStore((s) => s.deleteGroup)
  const importGroups = useAppStore((s) => s.importGroups)
  const exportGroups = useAppStore((s) => s.exportGroups)
  const importDataPath = useAppStore((s) => s.importDataPath)
  const settings = useAppStore((s) => s.settings)

  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<ProfileGroup | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [restoreLastSession, setRestoreLastSession] = useState(true)
  const [profileCount, setProfileCount] = useState(0)

  const [importOpen, setImportOpen] = useState(false)
  const [importRaw, setImportRaw] = useState('')
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [dataPath, setDataPath] = useState('')
  const [dataPreview, setDataPreview] = useState<DataImportPreview | null>(null)
  const [dataPreviewError, setDataPreviewError] = useState<string | null>(null)
  const [importTab, setImportTab] = useState<'folder' | 'json'>('folder')

  const profileCountByGroup = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of profiles) {
      if (!p.groupId) continue
      map.set(p.groupId, (map.get(p.groupId) ?? 0) + 1)
    }
    return map
  }, [profiles])

  // Giống ProfileFormModal: tiền tố = tên nhóm, số bắt đầu từ 1 (nhóm mới)
  const namePrefix = name.trim() || DEFAULT_PROFILE_PREFIX
  const safeProfileCount = Math.min(500, Math.max(0, Math.floor(profileCount) || 0))
  const startIndex = 1
  const namePad = Math.max(2, String(startIndex + Math.max(safeProfileCount, 1) - 1).length)
  const previewNames = useMemo(() => {
    if (safeProfileCount <= 0) return []
    const samples = Array.from({ length: Math.min(3, safeProfileCount) }, (_, i) =>
      formatProfileName(namePrefix, startIndex + i, namePad)
    )
    if (safeProfileCount > 3) {
      samples.push(`… ${formatProfileName(namePrefix, startIndex + safeProfileCount - 1, namePad)}`)
    }
    return samples
  }, [safeProfileCount, namePrefix, namePad])

  const importPreview = useMemo(() => {
    const text = importRaw.trim()
    if (!text) return null
    try {
      return { ok: true as const, ...summarizeImportPayload(parseImportGroupsJson(text)) }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'JSON không hợp lệ'
      }
    }
  }, [importRaw])

  function openCreate(): void {
    setEditing(null)
    setName('')
    setDescription('')
    setColor(GROUP_COLORS[groups.length % GROUP_COLORS.length])
    setRestoreLastSession(true)
    setProfileCount(0)
    setOpen(true)
  }

  function openEdit(group: ProfileGroup): void {
    setEditing(group)
    setName(group.name)
    setDescription(group.description)
    setColor(group.color)
    setRestoreLastSession(group.restoreLastSession !== false)
    setProfileCount(0)
    setOpen(true)
  }

  function openImport(): void {
    setImportRaw('')
    setDataPath('')
    setDataPreview(null)
    setDataPreviewError(null)
    setImportTab('folder')
    setImportOpen(true)
  }

  async function onPickImportFile(): Promise<void> {
    try {
      const content = await window.api.groups.pickImportFile()
      if (content == null) return
      setImportRaw(content)
      setImportTab('json')
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không đọc được file',
        description: error instanceof Error ? error.message : undefined
      })
    }
  }

  async function onPickDataFolder(): Promise<void> {
    try {
      const selected = await window.api.groups.pickDataPath()
      if (!selected) return
      setDataPath(selected)
      setDataPreviewError(null)
      const preview = await window.api.groups.previewDataImport(selected)
      setDataPreview(preview)
      setImportTab('folder')
    } catch (error) {
      setDataPreview(null)
      setDataPreviewError(error instanceof Error ? error.message : 'Không đọc được thư mục')
    }
  }

  async function onImportDataFolder(): Promise<void> {
    if (importing || !dataPath || !dataPreview) return
    setImporting(true)
    try {
      const result = await importDataPath(dataPath)
      const modeLabel =
        result.mode === 'groups'
          ? 'nhóm + hồ sơ'
          : result.mode === 'profiles'
            ? 'hồ sơ (kèm metadata)'
            : 'thư mục Chrome'
      const skipNote =
        result.skipped.length > 0 ? ` Bỏ qua/cảnh báo: ${result.skipped.length}.` : ''
      toast({
        tone: result.profilesCreated > 0 || result.groupsCreated > 0 ? 'success' : 'warning',
        title: `Đã nhập ${modeLabel}`,
        description: `Nhóm ${result.groupsCreated}, hồ sơ ${result.profilesCreated}, gắn sẵn ${result.dirsLinked}, copy ${result.dirsCopied}.${skipNote}`
      })
      setImportOpen(false)
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không thể nhập thư mục',
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setImporting(false)
    }
  }

  async function onImportSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (importing || !importPreview?.ok) return
    setImporting(true)
    try {
      const result = await importGroups(importRaw)
      const skipNote =
        result.skipped.length > 0
          ? ` Bỏ qua ${result.skipped.length} hồ sơ (thường do trùng email).`
          : ''
      toast({
        tone: result.skipped.length > 0 ? 'warning' : 'success',
        title: 'Đã nhập nhóm',
        description: `Tạo ${result.groupsCreated} nhóm, ${result.profilesCreated} hồ sơ.${skipNote}`
      })
      setImportOpen(false)
      setImportRaw('')
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không thể nhập nhóm',
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setImporting(false)
    }
  }

  async function onExportAll(): Promise<void> {
    if (exporting || groups.length === 0) return
    setExporting(true)
    try {
      const json = await exportGroups()
      const path = await window.api.groups.saveExportFile(json, 'chrome-manager-groups.json')
      if (!path) return
      toast({
        tone: 'success',
        title: 'Đã xuất nhóm',
        description: path
      })
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không thể xuất nhóm',
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setExporting(false)
    }
  }

  async function onExportOne(group: ProfileGroup): Promise<void> {
    try {
      const json = await exportGroups([group.id])
      const safeName = group.name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'group'
      const path = await window.api.groups.saveExportFile(
        json,
        `chrome-manager-${safeName}.json`
      )
      if (!path) return
      toast({
        tone: 'success',
        title: 'Đã xuất nhóm',
        description: path
      })
    } catch (error) {
      toast({
        tone: 'error',
        title: 'Không thể xuất nhóm',
        description: error instanceof Error ? error.message : undefined
      })
    }
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      if (editing) {
        await updateGroup(editing.id, { name, description, color, restoreLastSession })
        toast({ tone: 'success', title: 'Đã cập nhật nhóm' })
      } else {
        const group = await createGroup({ name, description, color, restoreLastSession })
        const count = Math.min(500, Math.max(0, Math.floor(profileCount) || 0))
        if (count > 0) {
          // Cùng logic đặt tên với form Tạo hồ sơ (Hồ sơ)
          const nextPrefix = group.name.trim() || DEFAULT_PROFILE_PREFIX
          const all = await window.api.profiles.list()
          const scoped = all.filter((p) => p.groupId === group.id)
          const next = suggestNextIndex(
            scoped.map((p) => p.name),
            nextPrefix
          )
          await createProfiles({
            name: nextPrefix,
            groupId: group.id,
            userAgent: settings?.defaultUserAgent ?? '',
            homepage: 'chrome://newtab/',
            count,
            startIndex: next
          })
          toast({
            tone: 'success',
            title: 'Đã tạo nhóm',
            description: `Đã tạo ${count} hồ sơ trong nhóm.`
          })
        } else {
          toast({ tone: 'success', title: 'Đã tạo nhóm' })
        }
      }
      setOpen(false)
    } catch (error) {
      toast({
        tone: 'error',
        title: editing ? 'Không thể cập nhật nhóm' : 'Không thể tạo nhóm',
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Nhóm hồ sơ"
        description="Phân loại hồ sơ theo dự án, khách hàng hoặc mục đích vận hành."
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void onExportAll()}
              disabled={groups.length === 0 || exporting}
            >
              <Download size={16} />
              {exporting ? 'Đang xuất...' : 'Xuất JSON'}
            </button>
            <button type="button" className="btn-secondary" onClick={openImport}>
              <Upload size={16} />
              Nhập nhóm
            </button>
            <button type="button" className="btn-primary" onClick={openCreate}>
              <Plus size={16} />
              Tạo nhóm
            </button>
          </div>
        }
      />

      {groups.length === 0 ? (
        <EmptyState
          title="Chưa có nhóm"
          description="Tạo nhóm để tổ chức hồ sơ dễ tìm kiếm và thao tác hàng loạt hơn."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" className="btn-secondary" onClick={openImport}>
                <Upload size={16} />
                Nhập nhóm
              </button>
              <button type="button" className="btn-primary" onClick={openCreate}>
                Tạo nhóm đầu tiên
              </button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => {
            const count = profileCountByGroup.get(group.id) ?? 0
            return (
              <div key={group.id} className="panel flex flex-col p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className="h-10 w-10 shrink-0 rounded-xl"
                      style={{ backgroundColor: group.color }}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-display text-base font-semibold text-ink">
                        {group.name}
                      </div>
                      <div className="text-xs text-ink-muted">{count} hồ sơ</div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="btn-ghost btn-icon"
                      aria-label="Xuất nhóm"
                      title="Xuất nhóm (JSON)"
                      onClick={() => void onExportOne(group)}
                    >
                      <Download size={15} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-icon"
                      aria-label="Sửa nhóm"
                      onClick={() => openEdit(group)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-icon text-danger"
                      aria-label="Xóa nhóm"
                      onClick={async () => {
                        const ok = await askConfirm({
                          title: `Xóa nhóm "${group.name}"?`,
                          description:
                            count > 0
                              ? `Sẽ xóa vĩnh viễn ${count} hồ sơ trong nhóm (kèm dữ liệu Chrome). Không thể hoàn tác.`
                              : 'Nhóm này không có hồ sơ. Bạn có chắc muốn xóa?',
                          confirmLabel: 'Xóa nhóm',
                          danger: true
                        })
                        if (!ok) return
                        await deleteGroup(group.id)
                        toast({
                          tone: 'success',
                          title: 'Đã xóa nhóm',
                          description:
                            count > 0 ? `Đã xóa ${count} hồ sơ trong nhóm.` : undefined
                        })
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                <p className="mt-3 min-h-[40px] flex-1 text-sm leading-relaxed text-ink-muted">
                  {group.description || 'Không có mô tả'}
                </p>
                <div className="mt-auto space-y-3 border-t border-line pt-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-ink-muted">
                      Tab cũ: {group.restoreLastSession ? 'Bật' : 'Tắt'}
                    </span>
                    <Switch
                      checked={group.restoreLastSession}
                      label="Tab cũ"
                      title="Mở lại tab lần chạy trước cho cả nhóm"
                      onChange={(next) => void updateGroup(group.id, { restoreLastSession: next })}
                    />
                  </div>
                  <div className="text-xs text-ink-muted">Cập nhật {formatDate(group.updatedAt)}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Sửa nhóm' : 'Tạo nhóm mới'}
      >
        <form className="space-y-4" onSubmit={(e) => void onSubmit(e)}>
          <div>
            <label className="label">Tên nhóm</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {!editing && (
            <>
              <div>
                <label className="label">Số lượng hồ sơ</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={500}
                  value={profileCount}
                  onChange={(e) => setProfileCount(Number(e.target.value))}
                />
                <p className="mt-1.5 text-xs text-ink-muted">
                  Nhập 0 nếu chỉ tạo nhóm trống. Tên hồ sơ tự động giống trang Hồ sơ.
                </p>
              </div>
              {safeProfileCount > 0 && (
                <div className="rounded-xl border border-line bg-surface-muted/40 p-4">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Tên tự động
                  </div>
                  <div className="font-mono text-sm text-ink">
                    {previewNames.join(' · ') ||
                      formatProfileName(namePrefix, startIndex, namePad)}
                  </div>
                  <div className="mt-2 text-xs text-ink-muted">
                    Tiền tố <span className="font-medium text-ink-soft">{namePrefix}</span>, bắt
                    đầu từ <span className="font-medium text-ink-soft">{startIndex}</span> (theo
                    hồ sơ trong nhóm)
                  </div>
                </div>
              )}
            </>
          )}
          <div>
            <label className="label">Mô tả</label>
            <textarea
              className="input min-h-[80px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Màu</label>
            <div className="flex flex-wrap gap-2">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="h-8 w-8 rounded-full border-2 border-transparent transition"
                  style={{
                    backgroundColor: c,
                    outline: color === c ? `2px solid ${c}` : undefined,
                    outlineOffset: 2
                  }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
          <div className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface-muted/40 px-4 py-3">
            <div className="min-w-0 text-sm text-ink-soft">
              <div className="font-medium text-ink">Mở lại tab lần chạy trước</div>
              <div className="mt-0.5 text-xs text-ink-muted">
                Áp dụng cho mọi hồ sơ trong nhóm (mặc định bật). Khi bật, trang khởi đầu bị bỏ qua.
              </div>
            </div>
            <Switch
              checked={restoreLastSession}
              label="Mở lại tab lần chạy trước"
              onChange={setRestoreLastSession}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              Hủy
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Đang lưu...' : editing ? 'Cập nhật' : 'Tạo nhóm'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Nhập nhóm / hồ sơ">
        <div className="space-y-4">
          <div className="flex gap-2">
            <button
              type="button"
              className={importTab === 'folder' ? 'btn-primary' : 'btn-secondary'}
              onClick={() => setImportTab('folder')}
            >
              Thư mục chrome-profiles
            </button>
            <button
              type="button"
              className={importTab === 'json' ? 'btn-primary' : 'btn-secondary'}
              onClick={() => setImportTab('json')}
            >
              JSON
            </button>
          </div>

          {importTab === 'folder' ? (
            <div className="space-y-4">
              <p className="text-sm text-ink-muted">
                Chọn thư mục <span className="font-medium text-ink-soft">chrome-profiles</span> hoặc{' '}
                <span className="font-medium text-ink-soft">data</span> (có thể kèm{' '}
                <span className="font-medium text-ink-soft">chrome-manager-db.json</span> cạnh đó). Có
                DB thì nhập nhóm + hồ sơ (giữ session); không có nhóm thì nhập hồ sơ; chỉ còn thư mục
                UUID thì gắn thành hồ sơ.
              </p>
              <button type="button" className="btn-secondary" onClick={() => void onPickDataFolder()}>
                Chọn thư mục…
              </button>
              {dataPath && (
                <div className="rounded-xl border border-line bg-surface-muted/40 p-3 text-xs text-ink-muted break-all">
                  {dataPath}
                </div>
              )}
              {dataPreviewError && (
                <div className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
                  {dataPreviewError}
                </div>
              )}
              {dataPreview && (
                <div className="rounded-xl border border-line bg-surface-muted/40 p-3 text-sm text-ink-soft">
                  Chế độ:{' '}
                  <span className="font-medium text-ink">
                    {dataPreview.mode === 'groups'
                      ? 'Nhóm + hồ sơ'
                      : dataPreview.mode === 'profiles'
                        ? 'Chỉ hồ sơ (có metadata)'
                        : 'Thư mục Chrome → hồ sơ'}
                  </span>
                  <div className="mt-1 text-xs text-ink-muted">
                    DB: {dataPreview.dbFound ? 'có' : 'không'} · Nhóm mới ~{dataPreview.groupCount} ·
                    Hồ sơ mới ~{dataPreview.profileCount} · Thư mục {dataPreview.folderCount} (mồ côi{' '}
                    {dataPreview.orphanFolderCount})
                  </div>
                  {dataPreview.groupNames.length > 0 && (
                    <div className="mt-1 text-xs text-ink-muted">
                      {dataPreview.groupNames.join(' · ')}
                      {dataPreview.groupCount > dataPreview.groupNames.length ? ' …' : ''}
                    </div>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => setImportOpen(false)}>
                  Hủy
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={importing || !dataPreview || dataPreview.profileCount + dataPreview.groupCount === 0}
                  onClick={() => void onImportDataFolder()}
                >
                  {importing ? 'Đang nhập...' : 'Nhập từ thư mục'}
                </button>
              </div>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={(e) => void onImportSubmit(e)}>
              <p className="text-sm text-ink-muted">
                Dán JSON nhóm (không mang session Chrome). Muốn giữ session hãy dùng tab thư mục.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={() => void onPickImportFile()}>
                  Chọn file JSON…
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setImportRaw(IMPORT_EXAMPLE)}
                >
                  Chèn ví dụ
                </button>
              </div>
              <div>
                <label className="label">Nội dung JSON</label>
                <textarea
                  className="input min-h-[220px] font-mono text-xs"
                  value={importRaw}
                  onChange={(e) => setImportRaw(e.target.value)}
                  placeholder={IMPORT_EXAMPLE}
                  spellCheck={false}
                />
              </div>
              {importPreview?.ok === true && (
                <div className="rounded-xl border border-line bg-surface-muted/40 p-3 text-sm text-ink-soft">
                  Sẽ tạo <span className="font-medium text-ink">{importPreview.groupCount}</span> nhóm,{' '}
                  <span className="font-medium text-ink">{importPreview.profileCount}</span> hồ sơ
                  {importPreview.names.length > 0 && (
                    <div className="mt-1 text-xs text-ink-muted">
                      {importPreview.names.slice(0, 5).join(' · ')}
                      {importPreview.names.length > 5 ? ' …' : ''}
                    </div>
                  )}
                </div>
              )}
              {importPreview?.ok === false && (
                <div className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
                  {importPreview.error}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => setImportOpen(false)}>
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={importing || !importPreview?.ok}
                >
                  {importing ? 'Đang nhập...' : 'Nhập JSON'}
                </button>
              </div>
            </form>
          )}
        </div>
      </Modal>
    </div>
  )
}
