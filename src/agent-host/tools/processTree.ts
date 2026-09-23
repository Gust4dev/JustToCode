import { execFile } from 'node:child_process'

/**
 * Mata o processo e toda a sua árvore de descendentes (`taskkill /T /F`).
 * Ignora erros (processo já encerrado / não encontrado).
 */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve()
      return
    }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}
