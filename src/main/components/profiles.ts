import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LlamaProfile } from '../../shared/components'

const CACHE_TYPES: readonly LlamaProfile['cacheType'][] = ['f16', 'q8_0', 'q4_0']

/** Perfil sugerido na primeira vez (sem modelo escolhido ainda). */
export function defaultProfile(): LlamaProfile {
  return {
    id: 'default',
    name: 'Padrão',
    modelPath: '',
    ctx: 32768,
    nCpuMoe: null,
    ngl: 99,
    flashAttn: true,
    cacheType: 'q8_0',
    port: 8080,
    extraArgs: ''
  }
}

/** `.gguf` simples ou o primeiro shard (`-00001-of-000NN.gguf`). */
export function isGgufModelPath(path: string): boolean {
  if (!/\.gguf$/i.test(path)) return false
  const shard = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(path)
  return !shard || Number(shard[1]) === 1
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const isInt = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max

/** Lança erro com mensagem para o usuário se o perfil for inválido. */
export function validateProfile(
  p: LlamaProfile,
  exists: (path: string) => boolean = fileExists
): void {
  if (!p || typeof p !== 'object') throw new Error('perfil inválido')
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('o perfil precisa de um nome')
  if (typeof p.modelPath !== 'string' || !isGgufModelPath(p.modelPath)) {
    throw new Error('escolha um arquivo .gguf (em modelos divididos, o arquivo -00001-of-000NN)')
  }
  if (!exists(p.modelPath)) throw new Error(`modelo não encontrado: ${p.modelPath}`)
  if (!isInt(p.ctx, 1)) throw new Error('contexto (-c) deve ser um inteiro positivo')
  if (!isInt(p.ngl, 0)) throw new Error('-ngl deve ser um inteiro ≥ 0')
  if (p.nCpuMoe !== null && !isInt(p.nCpuMoe, 0)) {
    throw new Error('--n-cpu-moe deve ser vazio ou um inteiro ≥ 0')
  }
  if (!CACHE_TYPES.includes(p.cacheType)) {
    throw new Error(`tipo de cache inválido: ${String(p.cacheType)}`)
  }
  if (!isInt(p.port, 1024, 65535)) throw new Error('a porta deve estar entre 1024 e 65535')
  if (typeof p.flashAttn !== 'boolean') throw new Error('flashAttn deve ser booleano')
  if (typeof p.extraArgs !== 'string') throw new Error('args extras devem ser texto')
  splitArgs(p.extraArgs) // aspas desbalanceadas → erro
}

/** Divide por espaço respeitando aspas simples/duplas. Aspas não fechadas → erro. */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (quote) throw new Error('args extras: aspas não fechadas')
  if (has) out.push(cur)
  return out
}

/** Argumentos do `llama-server` para o perfil (função pura). */
export function buildArgs(p: LlamaProfile): string[] {
  const args = ['-m', p.modelPath, '-c', String(p.ctx), '-ngl', String(p.ngl)]
  args.push('--port', String(p.port), '--host', '127.0.0.1')
  if (p.flashAttn) args.push('-fa', 'on')
  args.push('--cache-type-k', p.cacheType, '--cache-type-v', p.cacheType)
  if (p.nCpuMoe !== null) args.push('--n-cpu-moe', String(p.nCpuMoe))
  args.push(...splitArgs(p.extraArgs))
  return args
}

/** CRUD de perfis em `userData/llama/profiles.json`. */
export class ProfileStore {
  constructor(
    private readonly file: string,
    private readonly exists: (path: string) => boolean = fileExists
  ) {}

  private read(): LlamaProfile[] | null {
    if (!existsSync(this.file)) return null
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(data) ? (data as LlamaProfile[]) : []
    } catch {
      return []
    }
  }

  private async write(list: LlamaProfile[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(list, null, 2) + '\n', 'utf8')
  }

  /** Lista; na primeira vez grava e devolve o perfil padrão sugerido. */
  async list(): Promise<LlamaProfile[]> {
    const cur = this.read()
    if (cur !== null) return cur
    const first = [defaultProfile()]
    await this.write(first)
    return first
  }

  async get(id: string): Promise<LlamaProfile | null> {
    return (await this.list()).find((p) => p.id === id) ?? null
  }

  /** Valida e insere/atualiza (id vazio → novo id). */
  async save(p: LlamaProfile): Promise<LlamaProfile> {
    validateProfile(p, this.exists)
    const saved: LlamaProfile = { ...p, name: p.name.trim(), id: p.id || randomUUID() }
    const list = await this.list()
    const i = list.findIndex((x) => x.id === saved.id)
    if (i >= 0) list[i] = saved
    else list.push(saved)
    await this.write(list)
    return saved
  }

  async remove(id: string): Promise<void> {
    const list = await this.list()
    await this.write(list.filter((p) => p.id !== id))
  }
}
