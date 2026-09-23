import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)

let cached: string | null = null

/** Caminho do rg.exe; troca 'app.asar' por 'app.asar.unpacked' quando empacotado. */
export function rgPath(): string {
  if (cached) return cached
  const bin = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const pkg = `@vscode/ripgrep-${process.platform}-${process.arch}`
  const resolved = req.resolve(`${pkg}/bin/${bin}`)
  cached = resolved.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  return cached
}

export interface RgResult {
  code: number | null
  lines: string[]
  truncated: boolean
  stderr: string
}

/** Executa ripgrep coletando no máximo `maxLines` linhas de stdout. */
export function runRg(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  maxLines: number
): Promise<RgResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(rgPath(), args, {
      cwd,
      signal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const lines: string[] = []
    let buf = ''
    let stderr = ''
    let truncated = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return
      buf += chunk
      const parts = buf.split(/\r?\n/)
      buf = parts.pop() ?? ''
      for (const l of parts) {
        if (lines.length >= maxLines) {
          truncated = true
          child.kill()
          return
        }
        lines.push(l)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => {
      if (stderr.length < 4000) stderr += c
    })
    child.on('error', (err) => {
      if (truncated) return
      reject(err)
    })
    child.on('close', (code) => {
      if (!truncated && buf) {
        if (lines.length >= maxLines) truncated = true
        else lines.push(buf)
      }
      resolvePromise({ code, lines, truncated, stderr: stderr.trim() })
    })
  })
}

/** Normaliza saída do rg: '\' → '/', remove './' inicial e prefixa com a pasta relativa. */
export function toRootRel(line: string, relDir: string): string {
  const l = line.replace(/\\/g, '/').replace(/^\.\//, '')
  return relDir ? `${relDir}/${l}` : l
}
