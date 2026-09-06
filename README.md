# Chrome Manager

Ứng dụng desktop quản lý nhiều hồ sơ Chrome — lấy cảm hứng từ trải nghiệm tổ chức kiểu anti-detect profile manager (ví dụ GPMLogin), với kiến trúc và giao diện riêng.

## Công nghệ

| Lớp | Lựa chọn |
|-----|----------|
| Desktop shell | Electron |
| UI | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS (Light/Dark) |
| State | Zustand |
| IPC | Preload + contextBridge |
| Lưu trữ | JSON store trong `userData` (dễ thay bằng SQLite sau) |

## Tính năng

- CRUD + sao chép hồ sơ Chrome
- Nhóm hồ sơ, tìm kiếm / lọc / sắp xếp, chọn nhiều
- Khởi chạy / đóng / theo dõi trạng thái từng profile
- Thao tác hàng loạt (mở, đóng, xóa, đổi nhóm)
- Proxy, User Agent, homepage, tags, thư mục dữ liệu riêng
- Lưu Gmail dạng `mail|pass|recovery|2fa` và tự động đăng nhập (CDP + TOTP)
- Dashboard thống kê
- Cài đặt đường dẫn Chrome, theme, giới hạn mở đồng thời

## Chạy dự án

Cách dùng hàng ngày trên Windows: double-click **`Chrome Manager.lnk`** ở thư mục gốc project (không hiện cửa sổ CMD).

- Tạo / tạo lại shortcut: `scripts\create-shortcut.bat`
- Launcher ẩn CMD: `scripts\start-silent.vbs`
- Launcher có log: `scripts\start.bat`

Hoặc bằng terminal:

```bash
npm install
npm run dev
```

Build / đóng gói Windows:

```bash
npm run build
npm run dist
```

Installer nằm trong thư mục `release/`.

## Cấu trúc thư mục

```
chrome_manager/
  scripts/          # Launcher Windows (start, shortcut)
  data/             # Runtime: chrome-profiles, gmail-*.txt/json, screenshots
  src/
    main/
      db/           # JSON store (credentials mã hóa at-rest)
      services/     # Chrome, Gmail automation, IPC handlers
      utils/        # paths, locks, path-guard, credentials, sanitize
    preload/        # Typed contextBridge API
    renderer/src/
      components/   # layout, profiles, ui primitives
      features/     # domain UI (gmail…)
      pages/        # route-level screens
      stores/       # Zustand (app + ui toast/confirm)
    shared/         # Types + IPC channels dùng chung
```

- **UI** chỉ gọi `window.api.*` (typed preload)
- **Logic** nằm ở main services (`chrome.service`, `ipc.handlers`)
- **Dữ liệu hồ sơ** mặc định: `data/chrome-profiles/`
- **DB metadata** (profiles/groups/settings): `%APPDATA%` / `userData`

## Ghi chú vận hành

- Mỗi profile dùng `--user-data-dir` riêng để cô lập cookie/session.
- Proxy gắn qua `--proxy-server` khi khởi chạy Chrome.
- Cần cài Google Chrome (hoặc chỉ đường dẫn trong Cài đặt).
- File cũ ở root (`gmail-list.txt`, `chrome-profiles/`, …) được migrate tự động sang `data/` khi mở app.
"# chrome_manager" 
