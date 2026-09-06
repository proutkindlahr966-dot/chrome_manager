import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './services/ipc.handlers'
import { detectChromePath, stopAllRunning } from './services/chrome.service'
import { getDb } from './db/database'

let isQuitting = false

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'Chrome Manager',
    backgroundColor: '#0B1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (gotLock) {
  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.chromemanager.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const db = getDb()
    const settings = db.getSettings()
    if (!settings.chromePath) {
      const detected = detectChromePath()
      if (detected) db.updateSettings({ chromePath: detected })
    }

    // Reset stale running statuses after restart
    for (const profile of db.listProfiles()) {
      if (profile.status !== 'idle') {
        db.setProfileStatus(profile.id, 'idle')
      }
    }

    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', async (event) => {
    if (isQuitting) return
    const db = getDb()
    db.flush()
    const settings = db.getSettings()
    if (!settings.closeOnExit) return
    event.preventDefault()
    isQuitting = true
    try {
      await stopAllRunning()
    } finally {
      db.flush()
      app.exit(0)
    }
  })
}
