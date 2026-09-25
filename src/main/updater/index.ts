import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { reduceUpdate, normalizeNotes, type UpdateEvent, type UpdateState } from './state'

const MINUTE = 60 * 1000
/** Intervalo da verificação periódica. */
const CHECK_INTERVAL = 15 * MINUTE
/** Ao ganhar foco, verifica de novo se a última verificação foi há mais que isso. */
const FOCUS_STALE = 5 * MINUTE

export interface AppInfo {
  version: string
  isPackaged: boolean
}

let state: UpdateState = { phase: 'idle' }
let target: BrowserWindow | null = null
let started = false
// > 0 enquanto uma verificação automática (startup/periódica/foco) está em curso.
let autoChecks = 0
// > 0 enquanto uma verificação pedida pelo usuário está em curso (erro nunca é silencioso).
let manualChecks = 0
let lastCheck = 0

function dispatch(e: UpdateEvent): void {
  state = reduceUpdate(state, e)
  if (target && !target.isDestroyed()) target.webContents.send('update:state', state)
}

function autoCheck(): void {
  lastCheck = Date.now()
  autoChecks++
  void autoUpdater
    .checkForUpdates()
    .catch(() => {}) // já tratado no evento 'error'
    .finally(() => autoChecks--)
}

/** Liga o electron-updater à janela. Pode ser chamado de novo se a janela for recriada. */
export function initUpdater(win: BrowserWindow): void {
  target = win
  if (app.isPackaged) {
    win.on('focus', () => {
      if (Date.now() - lastCheck > FOCUS_STALE) autoCheck()
    })
  }
  if (started) return
  started = true

  const available = (i: UpdateInfo): void =>
    dispatch({ type: 'available', version: i.version, notes: normalizeNotes(i.releaseNotes) })

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => dispatch({ type: 'check' }))
  autoUpdater.on('update-not-available', () => dispatch({ type: 'none' }))
  autoUpdater.on('update-available', available)
  autoUpdater.on('download-progress', (p) => dispatch({ type: 'progress', percent: p.percent }))
  autoUpdater.on('update-downloaded', () => dispatch({ type: 'downloaded' }))
  autoUpdater.on('error', (err) => {
    const silent = autoChecks > 0 && manualChecks === 0
    if (silent) console.warn('[updater] verificação automática falhou:', err.message)
    dispatch({ type: 'error', message: err.message, silent })
  })

  ipcMain.handle('update:get', () => state)
  ipcMain.handle('update:info', (): AppInfo => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged
  }))
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return
    lastCheck = Date.now()
    manualChecks++
    try {
      await autoUpdater.checkForUpdates()
    } finally {
      manualChecks--
    }
  })
  ipcMain.handle('update:download', async () => {
    await autoUpdater.downloadUpdate()
  })
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true))

  if (app.isPackaged) {
    autoCheck()
    setInterval(autoCheck, CHECK_INTERVAL)
  }
}
