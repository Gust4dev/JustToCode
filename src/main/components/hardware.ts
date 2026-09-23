import { execFile } from 'node:child_process'
import { totalmem } from 'node:os'
import type { HardwareInfo } from '../../shared/components'

export type ExecFn = (cmd: string, args: string[]) => Promise<string>

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout))
    )
  })

/** Primeira linha de `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader`. */
export function parseNvidiaSmi(out: string): Pick<HardwareInfo, 'gpuName' | 'vramMB' | 'driver'> {
  const line = out.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const [name, mem, driver] = line.split(',').map((s) => s.trim())
  const m = mem ? /^(\d+)\s*MiB$/i.exec(mem) : null
  return {
    gpuName: name || null,
    vramMB: m ? Number(m[1]) : null,
    driver: driver || null
  }
}

/** nvidia-smi (ausente/falhou → GPU null) + `os.totalmem()`. */
export async function detectHardware(exec: ExecFn = defaultExec): Promise<HardwareInfo> {
  const ramMB = Math.round(totalmem() / (1024 * 1024))
  try {
    const out = await exec('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader'
    ])
    return { ...parseNvidiaSmi(out), ramMB }
  } catch {
    return { gpuName: null, vramMB: null, driver: null, ramMB }
  }
}
