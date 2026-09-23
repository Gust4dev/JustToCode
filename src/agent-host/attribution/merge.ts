import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './git'

export interface MergeResult {
  clean: boolean
  text: string
}

/**
 * Merge de três vias via `git merge-file -p --diff3`. `current` é o lado mantido,
 * `base` o ancestral comum e `other` o lado cujas mudanças (base → other) são aplicadas.
 * Os bytes vão para o disco como estão (sem conversão de fim de linha), em arquivos
 * temporários que são sempre apagados.
 */
export async function threeWayMerge(
  current: string,
  base: string,
  other: string
): Promise<MergeResult> {
  const dir = await mkdtemp(join(tmpdir(), 'jtc-merge-'))
  try {
    const cur = join(dir, 'current')
    const bas = join(dir, 'base')
    const oth = join(dir, 'other')
    await Promise.all([writeFile(cur, current), writeFile(bas, base), writeFile(oth, other)])
    const r = await git(dir, [
      'merge-file',
      '-p',
      '--diff3',
      '-L',
      'atual',
      '-L',
      'depois do chat',
      '-L',
      'revertido',
      cur,
      bas,
      oth
    ])
    // Código > 0 = número de conflitos (até 127); negativo (255 etc.) = erro.
    if (r.code < 0 || r.code > 127) {
      throw new Error(`git merge-file falhou (código ${r.code})`)
    }
    return { clean: r.code === 0, text: r.stdout.toString('utf8') }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
