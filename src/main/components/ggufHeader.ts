import type { GgufMeta } from '../../shared/components'

// Formato: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
// header = magic "GGUF" (u32) | version u32 | tensor_count u64 | metadata_kv_count u64 (v2/v3)
// kv = key (string: u64 len + bytes) | value_type u32 | valor
// tipos: 0 u8, 1 i8, 2 u16, 3 i16, 4 u32, 5 i32, 6 f32, 7 bool, 8 string, 9 array
//        (elem_type u32 + count u64 + itens), 10 u64, 11 i64, 12 f64

const MAGIC = 0x46554747 // "GGUF" em little-endian
const FIXED_SIZE: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8
}
/** Strings maiores que isso são puladas sem decodificar. */
const MAX_STRING = 256

/** O buffer terminou antes do fim dos KV: é preciso ler mais bytes. */
export class NeedMoreData extends Error {
  constructor() {
    super('GGUF: header incompleto')
  }
}

type Scalar = number | string | boolean

class Cursor {
  pos = 0
  constructor(private readonly buf: Buffer) {}
  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new NeedMoreData()
  }
  u32(): number {
    this.need(4)
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }
  u64(): number {
    this.need(8)
    const v = this.buf.readBigUInt64LE(this.pos)
    this.pos += 8
    if (v > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('GGUF: inteiro de 64 bits grande demais')
    return Number(v)
  }
  skip(n: number): void {
    this.need(n)
    this.pos += n
  }
  /** Lê uma string GGUF; devolve null (e pula) quando for longa demais. */
  str(): string | null {
    const len = this.u64()
    if (len > MAX_STRING) {
      this.skip(len)
      return null
    }
    this.need(len)
    const s = this.buf.toString('utf8', this.pos, this.pos + len)
    this.pos += len
    return s
  }
  scalar(type: number): Scalar {
    const b = this.buf
    const size = FIXED_SIZE[type]
    this.need(size)
    const p = this.pos
    this.pos += size
    switch (type) {
      case 0:
        return b.readUInt8(p)
      case 1:
        return b.readInt8(p)
      case 2:
        return b.readUInt16LE(p)
      case 3:
        return b.readInt16LE(p)
      case 4:
        return b.readUInt32LE(p)
      case 5:
        return b.readInt32LE(p)
      case 6:
        return b.readFloatLE(p)
      case 7:
        return b.readUInt8(p) !== 0
      case 10:
        return Number(b.readBigUInt64LE(p))
      case 11:
        return Number(b.readBigInt64LE(p))
      case 12:
        return b.readDoubleLE(p)
    }
    throw new Error(`GGUF: tipo escalar inválido ${type}`)
  }
  /** Pula um valor do tipo dado (usado para arrays). */
  skipValue(type: number): void {
    if (type in FIXED_SIZE) return this.skip(FIXED_SIZE[type])
    if (type === 8) return this.skip(this.u64())
    if (type === 9) {
      const elem = this.u32()
      const count = this.u64()
      if (elem in FIXED_SIZE) return this.skip(FIXED_SIZE[elem] * count)
      for (let i = 0; i < count; i++) this.skipValue(elem)
      return
    }
    throw new Error(`GGUF: tipo de valor inválido ${type}`)
  }
}

export interface GgufHeader {
  version: number
  tensorCount: number
  /** Só valores escalares e strings curtas; arrays e strings longas ficam de fora. */
  kv: Map<string, Scalar>
  /** Bytes consumidos até o fim dos KV. */
  headerBytes: number
}

/** Faz o parse do header + KV. Lança `NeedMoreData` se o buffer acabar antes. */
export function parseGgufHeader(buf: Buffer): GgufHeader {
  const c = new Cursor(buf)
  if (c.u32() !== MAGIC) throw new Error('GGUF: arquivo não é GGUF (magic inválido)')
  const version = c.u32()
  if (version < 2 || version > 3) throw new Error(`GGUF: versão ${version} não suportada`)
  const tensorCount = c.u64()
  const kvCount = c.u64()
  const kv = new Map<string, Scalar>()
  for (let i = 0; i < kvCount; i++) {
    const key = c.str()
    const type = c.u32()
    if (type === 8) {
      const s = c.str()
      if (key !== null && s !== null) kv.set(key, s)
    } else if (type === 9) {
      c.skipValue(9)
    } else if (type in FIXED_SIZE) {
      const v = c.scalar(type)
      if (key !== null) kv.set(key, v)
    } else {
      throw new Error(`GGUF: tipo de valor inválido ${type}`)
    }
  }
  return { version, tensorCount, kv, headerBytes: c.pos }
}

/** Extrai os campos usados na estimativa. */
export function metaFromKv(kv: Map<string, Scalar>): GgufMeta {
  const archV = kv.get('general.architecture')
  const arch = typeof archV === 'string' ? archV : null
  const num = (k: string): number | null => {
    if (!arch) return null
    const v = kv.get(`${arch}.${k}`)
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  return {
    arch,
    blockCount: num('block_count'),
    embeddingLength: num('embedding_length'),
    headCount: num('attention.head_count'),
    headCountKv: num('attention.head_count_kv'),
    keyLength: num('attention.key_length'),
    valueLength: num('attention.value_length'),
    contextLength: num('context_length'),
    expertCount: num('expert_count')
  }
}

export function parseGgufMeta(buf: Buffer): GgufMeta {
  return metaFromKv(parseGgufHeader(buf).kv)
}

const START_BYTES = 1 << 20
const MAX_BYTES = 32 << 20

/** Lê `[start, end)` com `Range`; se o servidor devolver 200, descarta o prefixo. Nunca lê além de `end`. */
async function fetchRange(
  url: string,
  start: number,
  end: number,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<{ data: Buffer; eof: boolean }> {
  const res = await fetchImpl(url, { headers: { range: `bytes=${start}-${end - 1}` }, signal })
  if (res.status === 416) return { data: Buffer.alloc(0), eof: true }
  if (!res.ok) throw new Error(`GGUF: servidor respondeu ${res.status} para ${url}`)
  const skipFirst = res.status === 206 ? 0 : start
  const want = end - start
  const chunks: Buffer[] = []
  let got = 0
  let skipped = 0
  let eof = true
  const reader = res.body?.getReader()
  if (!reader) return { data: Buffer.alloc(0), eof: true }
  try {
    while (got < want) {
      const { done, value } = await reader.read()
      if (done) break
      let chunk = Buffer.from(value)
      if (skipped < skipFirst) {
        const drop = Math.min(chunk.length, skipFirst - skipped)
        skipped += drop
        chunk = chunk.subarray(drop)
      }
      if (!chunk.length) continue
      const take = chunk.subarray(0, want - got)
      chunks.push(take)
      got += take.length
    }
    if (got >= want) eof = false
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const data = Buffer.concat(chunks)
  return { data, eof: eof && data.length < want }
}

/**
 * Lê o header de um GGUF remoto por `Range`, em blocos que começam em 1 MB e dobram até 32 MB,
 * parando assim que os KV terminam.
 */
export async function readGgufMeta(
  url: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; maxBytes?: number } = {}
): Promise<GgufMeta> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  let buf = Buffer.alloc(0)
  let target = Math.min(START_BYTES, maxBytes)
  for (;;) {
    const { data, eof } = await fetchRange(url, buf.length, target, fetchImpl, opts.signal)
    buf = Buffer.concat([buf, data])
    try {
      return parseGgufMeta(buf)
    } catch (e) {
      if (!(e instanceof NeedMoreData)) throw e
      if (eof || buf.length < target)
        throw new Error('GGUF: arquivo terminou antes do fim do header')
      if (target >= maxBytes) throw new Error(`GGUF: header maior que ${maxBytes} bytes`)
      target = Math.min(target * 2, maxBytes)
    }
  }
}
