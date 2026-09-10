export type ProfileColumnId =
  | 'name'
  | 'notes'
  | 'group'
  | 'gmail'
  | 'proxy'
  | 'restore'
  | 'status'
  | 'lastLaunched'
  | 'actions'

export interface ProfileColumnDef {
  id: ProfileColumnId
  label: string
  /** Không cho tắt */
  locked?: boolean
}

export const PROFILE_COLUMNS: ProfileColumnDef[] = [
  { id: 'name', label: 'Hồ sơ', locked: true },
  { id: 'notes', label: 'Ghi chú' },
  { id: 'group', label: 'Nhóm' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'restore', label: 'Tab cũ' },
  { id: 'status', label: 'Trạng thái' },
  { id: 'lastLaunched', label: 'Lần chạy' },
  { id: 'actions', label: 'Thao tác', locked: true }
]

export const DEFAULT_VISIBLE_COLUMNS: ProfileColumnId[] = PROFILE_COLUMNS.map((c) => c.id)

const STORAGE_KEY = 'chrome-manager.profile-table-columns'

export function loadVisibleColumns(): ProfileColumnId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return [...DEFAULT_VISIBLE_COLUMNS]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...DEFAULT_VISIBLE_COLUMNS]
    const allowed = new Set(PROFILE_COLUMNS.map((c) => c.id))
    const next = parsed.filter((id): id is ProfileColumnId => typeof id === 'string' && allowed.has(id as ProfileColumnId))
    // Cột mới: chèn Ghi chú ngay sau Hồ sơ nếu preference cũ chưa có
    if (!next.includes('notes')) {
      const nameIdx = next.indexOf('name')
      next.splice(nameIdx >= 0 ? nameIdx + 1 : 0, 0, 'notes')
    }
    // Luôn giữ cột khóa
    for (const col of PROFILE_COLUMNS) {
      if (col.locked && !next.includes(col.id)) next.push(col.id)
    }
    return next.length ? next : [...DEFAULT_VISIBLE_COLUMNS]
  } catch {
    return [...DEFAULT_VISIBLE_COLUMNS]
  }
}

export function saveVisibleColumns(ids: ProfileColumnId[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // ignore
  }
}

export function isColumnVisible(visible: ProfileColumnId[], id: ProfileColumnId): boolean {
  return visible.includes(id)
}
