import { execFile } from 'node:child_process'

export interface GitResult {
  stdout: Buffer
  code: number
}

/**
 * Roda git (sem shell) com cwd = root. Nunca rejeita por código de saída ≠ 0:
 * o chamador decide pelo `code`. Rejeita só se o git não puder ser executado.
 */
export function git(
  root: string,
  args: string[],
  opts: { input?: string; maxBuffer?: number } = {}
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd: root,
        encoding: 'buffer',
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        windowsHide: true
      },
      (err, stdout) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: unknown }).code
          if (typeof code === 'number') return resolve({ stdout, code })
          return reject(err)
        }
        resolve({ stdout, code: 0 })
      }
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
    else child.stdin?.end()
  })
}
