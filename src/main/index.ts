import { app, shell, BrowserWindow, ipcMain, dialog, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startAgentHost, type AgentHostHandle } from './agentHost'
import { initUpdater } from './updater'
import { initComponents, stopComponents } from './components'
import { loadSettings, saveSettings, electronCodec } from './settings'
import type { AppConfig } from '@shared/domain'
import { MIN_SIZE, loadWindowState, resolveInitialWindow, saveWindowState } from './windowState'

let host: AgentHostHandle | null = null

const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')
const currentSettings = (): AppConfig => loadSettings(settingsFile(), electronCodec())
const windowStateFile = (): string => join(app.getPath('userData'), 'window-state.json')

function createWindow(): void {
  const initial = resolveInitialWindow(
    loadWindowState(windowStateFile()),
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea
  )
  const mainWindow = new BrowserWindow({
    ...initial.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (initial.maximized) mainWindow.maximize()
    mainWindow.show()
  })

  // getNormalBounds guarda o tamanho "restaurado" mesmo com a janela maximizada.
  mainWindow.on('close', () => {
    saveWindowState(windowStateFile(), {
      bounds: mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized()
    })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  host?.dispose()
  host = startAgentHost(mainWindow, currentSettings)
  initUpdater(mainWindow)
  initComponents(mainWindow)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('settings:get', (): AppConfig => currentSettings())
  ipcMain.handle('settings:set', (_, patch: Partial<AppConfig>): AppConfig => {
    const next = saveSettings(settingsFile(), electronCodec(), patch ?? {})
    host?.pushConfig()
    return next
  })
  ipcMain.handle('dialog:pickFolder', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { properties: ['openDirectory' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
let componentsStopped = false
app.on('before-quit', (event) => {
  host?.dispose()
  host = null
  // Para só os processos gerenciados (9router/llama iniciados pelo app) antes de sair.
  if (!componentsStopped) {
    componentsStopped = true
    event.preventDefault()
    const timeout = new Promise((r) => setTimeout(r, 8000))
    void Promise.race([stopComponents().catch(() => undefined), timeout]).then(() => app.quit())
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
