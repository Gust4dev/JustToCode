import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { reduceUpdate, normalizeNotes, type UpdateEvent, type UpdateState } from './state'

const HOUR = 60 * 60 * 1000

let state: UpdateState = { phase: 'idle' }
let target: BrowserWindow | null = null
let started = false
// > 0 enquanto uma verificação automática (startup/horária) está em curso.
let autoChecks = 0

function dispatch(e: UpdateEvent): void {
  state = reduceUpdate(state, e)
  if (target && !target.isDestroyed()) target.webContents.send('update:state', state)
}

/** Liga o electron-updater à janela. Pode ser chamado de novo se a janela for recriada. */
export function initUpdater(win: BrowserWindow): void {
  target = win
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
    const silent = autoChecks > 0
    if (silent) console.warn('[updater] verificação automática falhou:', err.message)
    dispatch({ type: 'error', message: err.message, silent })
  })

  ipcMain.handle('update:get', () => state)
  ipcMain.handle('update:check', async () => {
    if (app.isPackaged) await autoUpdater.checkForUpdates()
  })
  ipcMain.handle('update:download', async () => {
    await autoUpdater.downloadUpdate()
  })
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall())

  if (app.isPackaged) {
    const check = (): void => {
      autoChecks++
      void autoUpdater
        .checkForUpdates()
        .catch(() => {}) // já tratado no evento 'error'
        .finally(() => autoChecks--)
    }
    check()
    setInterval(check, HOUR)
  }
}
