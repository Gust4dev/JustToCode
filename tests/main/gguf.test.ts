import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NeedMoreData,
  parseGgufHeader,
  parseGgufMeta,
  readGgufMeta
} from '../../src/main/components/ggufHeader'
import {
  extractQuant,
  groupGgufFiles,
  listGgufFiles,
  searchRepos,
  type HfTreeEntry
} from '../../src/main/components/huggingface'
import { createModelsService, groupPaths, modelDest } from '../../src/main/components/models'
import { download, type DownloadParams } from '../../src/main/components/downloader'
import type { DownloadProgress, GgufFile } from '../../src/shared/components'

// ---------- GGUF sintético ----------
type Val =
  | { t: 'u32'; v: number }
  | { t: 'u64'; v: number }
  | { t: 'f32'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'str'; v: string }
  | { t: 'arrStr'; v: string[] }
  | { t: 'arrI32'; v: number[] }

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}
const gstr = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([u64(b.length), b])
}
function encVal(v: Val): Buffer {
  switch (v.t) {
    case 'u32':
      return Buffer.concat([u32(4), u32(v.v)])
    case 'u64':
      return Buffer.concat([u32(10), u64(v.v)])
    case 'f32': {
      const b = Buffer.alloc(4)
      b.writeFloatLE(v.v)
      return Buffer.concat([u32(6), b])
    }
    case 'bool':
      return Buffer.concat([u32(7), Buffer.from([v.v ? 1 : 0])])
    case 'str':
      return Buffer.concat([u32(8), gstr(v.v)])
    case 'arrStr':
      return Buffer.concat([u32(9), u32(8), u64(v.v.length), ...v.v.map(gstr)])
    case 'arrI32': {
      const items = v.v.map((n) => {
        const b = Buffer.alloc(4)
        b.writeInt32LE(n)
        return b
      })
      return Buffer.concat([u32(9), u32(5), u64(v.v.length), ...items])
    }
  }
}
function buildGguf(kv: [string, Val][], version = 3, tail = 4096): Buffer {
  const parts = [Buffer.from('GGUF', 'ascii'), u32(version), u64(1), u64(kv.length)]
  for (const [k, v] of kv) parts.push(gstr(k), encVal(v))
  parts.push(Buffer.alloc(tail, 0xab)) // "tensor info"/dados
  return Buffer.concat(parts)
}

const QWEN_MOE: [string, Val][] = [
  ['general.architecture', { t: 'str', v: 'qwen3moe' }],
  ['general.name', { t: 'str', v: 'x'.repeat(1000) }], // string longa: pulada
  ['general.file_type', { t: 'u32', v: 15 }],
  ['qwen3moe.block_count', { t: 'u32', v: 48 }],
  ['qwen3moe.context_length', { t: 'u32', v: 40960 }],
  ['qwen3moe.embedding_length', { t: 'u32', v: 2048 }],
  ['qwen3moe.attention.head_count', { t: 'u32', v: 32 }],
  ['qwen3moe.attention.head_count_kv', { t: 'u32', v: 4 }],
  ['qwen3moe.attention.key_length', { t: 'u32', v: 128 }],
  ['qwen3moe.attention.value_length', { t: 'u32', v: 128 }],
  ['qwen3moe.expert_count', { t: 'u64', v: 128 }],
  ['qwen3moe.rope.freq_base', { t: 'f32', v: 1000000 }],
  ['tokenizer.ggml.add_bos_token', { t: 'bool', v: false }],
  ['tokenizer.ggml.token_type', { t: 'arrI32', v: [1, 2, 3] }]
]

describe('ggufHeader', () => {
  it('extrai os campos da arquitetura (v3), pulando arrays e strings longas', () => {
    const buf = buildGguf([
      ...QWEN_MOE,
      ['tokenizer.ggml.tokens', { t: 'arrStr', v: ['a', 'bb', 'ccc'] }]
    ])
    const h = parseGgufHeader(buf)
    expect(h.version).toBe(3)
    expect(h.kv.has('general.name')).toBe(false)
    expect(h.kv.has('tokenizer.ggml.tokens')).toBe(false)
    expect(h.kv.get('tokenizer.ggml.add_bos_token')).toBe(false)
    expect(parseGgufMeta(buf)).toEqual({
      arch: 'qwen3moe',
      blockCount: 48,
      embeddingLength: 2048,
      headCount: 32,
      headCountKv: 4,
      keyLength: 128,
      valueLength: 128,
      contextLength: 40960,
      expertCount: 128
    })
  })
  it('aceita v2 e campos ausentes viram null', () => {
    const buf = buildGguf(
      [
        ['general.architecture', { t: 'str', v: 'llama' }],
        ['llama.block_count', { t: 'u32', v: 32 }]
      ],
      2
    )
    const m = parseGgufMeta(buf)
    expect(m.arch).toBe('llama')
    expect(m.blockCount).toBe(32)
    expect(m.headCountKv).toBeNull()
    expect(m.expertCount).toBeNull()
  })
  it('buffer truncado → NeedMoreData; magic/versão inválidos → erro', () => {
    const buf = buildGguf(QWEN_MOE)
    expect(() => parseGgufHeader(buf.subarray(0, 60))).toThrow(NeedMoreData)
    expect(() => parseGgufHeader(Buffer.from('NOPE0000000000000000000000'))).toThrow(/magic/)
    const v1 = buildGguf(QWEN_MOE)
    v1.writeUInt32LE(1, 4)
    expect(() => parseGgufHeader(v1)).toThrow(/versão 1/)
  })
})

// ---------- servidor local ----------
let server: Server
let base = ''
const blobs = new Map<string, Buffer>()
const rangeLog: string[] = []
let ignoreRange = false
let apiRoutes: Record<string, unknown> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname.startsWith('/api/')) {
      const body = apiRoutes[url.pathname + url.search] ?? apiRoutes[url.pathname]
      if (body === undefined) {
        res.statusCode = 404
        return res.end()
      }
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(body))
    }
    const blob = blobs.get(decodeURIComponent(url.pathname))
    if (!blob) {
      res.statusCode = 404
      return res.end()
    }
    const range = req.headers.range
    rangeLog.push(range ?? '')
    const m = range && !ignoreRange ? /bytes=(\d+)-(\d*)/.exec(range) : null
    if (m) {
      const start = Number(m[1])
      const end = m[2] ? Math.min(Number(m[2]), blob.length - 1) : blob.length - 1
      if (start >= blob.length) {
        res.statusCode = 416
        return res.end()
      }
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${blob.length}`)
      res.setHeader('content-length', String(end - start + 1))
      return res.end(blob.subarray(start, end + 1))
    }
    res.setHeader('content-length', String(blob.length))
    return res.end(blob)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('readGgufMeta (Range)', () => {
  it('lê o header em um bloco quando é pequeno', async () => {
    blobs.set('/small.gguf', buildGguf(QWEN_MOE, 3, 3 << 20))
    rangeLog.length = 0
    const m = await readGgufMeta(`${base}/small.gguf`)
    expect(m.blockCount).toBe(48)
    expect(rangeLog).toEqual(['bytes=0-1048575'])
  })
  it('cresce os blocos quando o header passa de 1 MB (vocabulário grande)', async () => {
    const vocab = Array.from({ length: 200_000 }, (_, i) => `tok${i}`)
    const buf = buildGguf([
      ['general.architecture', { t: 'str', v: 'llama' }],
      ['tokenizer.ggml.tokens', { t: 'arrStr', v: vocab }],
      ['llama.block_count', { t: 'u32', v: 32 }]
    ])
    expect(buf.length).toBeGreaterThan(2 << 20)
    blobs.set('/big.gguf', buf)
    rangeLog.length = 0
    const m = await readGgufMeta(`${base}/big.gguf`)
    expect(m.blockCount).toBe(32)
    expect(rangeLog[0]).toBe('bytes=0-1048575')
    expect(rangeLog[1]).toBe('bytes=1048576-2097151')
    expect(rangeLog.length).toBeGreaterThanOrEqual(2)
  })
  it('funciona com servidor que ignora Range (200)', async () => {
    const vocab = Array.from({ length: 200_000 }, (_, i) => `tok${i}`)
    blobs.set(
      '/norange.gguf',
      buildGguf([
        ['general.architecture', { t: 'str', v: 'llama' }],
        ['tokenizer.ggml.tokens', { t: 'arrStr', v: vocab }],
        ['llama.block_count', { t: 'u32', v: 28 }]
      ])
    )
    ignoreRange = true
    try {
      expect((await readGgufMeta(`${base}/norange.gguf`)).blockCount).toBe(28)
    } finally {
      ignoreRange = false
    }
  })
  it('para no limite de bytes e em arquivo truncado', async () => {
    blobs.set('/trunc.gguf', buildGguf(QWEN_MOE, 3, 0).subarray(0, 100))
    await expect(readGgufMeta(`${base}/trunc.gguf`)).rejects.toThrow(/terminou/)
    const vocab = Array.from({ length: 200_000 }, (_, i) => `tok${i}`)
    blobs.set('/huge.gguf', buildGguf([['tokenizer.ggml.tokens', { t: 'arrStr', v: vocab }]]))
    await expect(readGgufMeta(`${base}/huge.gguf`, { maxBytes: 1 << 20 })).rejects.toThrow(
      /maior que/
    )
  })
})

describe('huggingface', () => {
  it('extrai a quantização do nome', () => {
    expect(extractQuant('Qwen3-30B-A3B-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(extractQuant('Qwen3-30B-A3B-UD-Q4_K_XL.gguf')).toBe('Q4_K_XL')
    expect(extractQuant('model-Q8_0.gguf')).toBe('Q8_0')
    expect(extractQuant('Qwen3-30B-A3B-IQ4_XS.gguf')).toBe('IQ4_XS')
    expect(extractQuant('BF16/Qwen3-30B-A3B-BF16-00001-of-00002.gguf')).toBe('BF16')
    expect(extractQuant('llama-f16.gguf')).toBe('F16')
    expect(extractQuant('Q5_K_S/model-q5_k_s.gguf')).toBe('Q5_K_S')
    expect(extractQuant('mmproj.gguf')).toBeNull()
  })
  it('filtra .gguf, usa lfs.size/oid e agrupa shards', () => {
    const tree: HfTreeEntry[] = [
      { type: 'directory', path: 'BF16', size: 0 },
      { type: 'file', path: '.gitattributes', size: 10 },
      { type: 'file', path: 'README.md', size: 10 },
      { type: 'file', path: 'm-Q4_K_M.gguf', size: 134, lfs: { oid: 'aa', size: 1000 } },
      {
        type: 'file',
        path: 'BF16/m-BF16-00002-of-00002.gguf',
        size: 134,
        lfs: { oid: 'c2', size: 30 }
      },
      {
        type: 'file',
        path: 'BF16/m-BF16-00001-of-00002.gguf',
        size: 134,
        lfs: { oid: 'c1', size: 70 }
      }
    ]
    expect(groupGgufFiles('o/r', tree)).toEqual([
      {
        repo: 'o/r',
        path: 'm-Q4_K_M.gguf',
        size: 1000,
        sha256: 'aa',
        quant: 'Q4_K_M',
        shardIndex: null,
        shardCount: null
      },
      {
        repo: 'o/r',
        path: 'BF16/m-BF16-00001-of-00002.gguf',
        size: 100,
        sha256: 'c1',
        quant: 'BF16',
        shardIndex: 1,
        shardCount: 2
      }
    ])
    expect(groupPaths('BF16/m-BF16-00001-of-00002.gguf')).toEqual([
      'BF16/m-BF16-00001-of-00002.gguf',
      'BF16/m-BF16-00002-of-00002.gguf'
    ])
  })
  it('search e files falam com a API (servidor local)', async () => {
    apiRoutes = {
      '/api/models?search=qwen&filter=gguf&sort=downloads&direction=-1&limit=25': [
        { id: 'o/r', likes: 3, downloads: 99, createdAt: '2025-01-01T00:00:00.000Z' }
      ],
      '/api/models/o/r/tree/main?recursive=true': [
        { type: 'file', path: 'x-Q8_0.gguf', size: 5, lfs: { oid: 'h', size: 50 } }
      ]
    }
    expect(await searchRepos('qwen', { baseUrl: base })).toEqual([
      { id: 'o/r', downloads: 99, likes: 3, updatedAt: '2025-01-01T00:00:00.000Z' }
    ])
    const files = await listGgufFiles('o/r', { baseUrl: base })
    expect(files).toMatchObject([{ path: 'x-Q8_0.gguf', size: 50, sha256: 'h', quant: 'Q8_0' }])
    await expect(listGgufFiles('../etc', { baseUrl: base })).rejects.toThrow(/inválido/)
  })
})

describe('models service', () => {
  const hw = { gpuName: 'RTX', vramMB: 8192, driver: '1', ramMB: 32768 }
  const mk = (
    downloadImpl: (p: DownloadParams) => Promise<void> = download
  ): {
    svc: ReturnType<typeof createModelsService>
    userData: string
    progress: DownloadProgress[]
  } => {
    const userData = mkdtempSync(join(tmpdir(), 'jtc-models-'))
    const progress: DownloadProgress[] = []
    const svc = createModelsService({
      userData,
      downloads: new Map(),
      emitProgress: (p) => progress.push(p),
      getHardware: async () => hw,
      downloadImpl,
      baseUrl: base
    })
    return { svc, userData, progress }
  }

  it('dir padrão, setDir e local() recursivo', async () => {
    const { svc, userData } = mk()
    expect(await svc.dir()).toBe(join(userData, 'models'))
    const other = join(userData, 'outra')
    await svc.setDir(other)
    expect(await svc.dir()).toBe(other)
    mkdirSync(join(other, 'o__r'), { recursive: true })
    writeFileSync(join(other, 'o__r', 'a.gguf'), 'abc')
    writeFileSync(join(other, 'o__r', 'b.gguf.part'), 'abc')
    writeFileSync(join(other, 'x.txt'), 'abc')
    expect(await svc.local()).toEqual([
      { path: join(other, 'o__r', 'a.gguf'), name: 'a.gguf', size: 3 }
    ])
    await expect(svc.setDir('relativo')).rejects.toThrow(/absoluto/)
  })

  it('download de arquivo único com sha256 (downloader real, servidor local)', async () => {
    const data = Buffer.alloc(5000, 7)
    blobs.set('/o/r/resolve/main/sub/m-Q4_K_M.gguf', data)
    const sha = createHash('sha256').update(data).digest('hex')
    const { svc, userData, progress } = mk()
    const file: GgufFile = {
      repo: 'o/r',
      path: 'sub/m-Q4_K_M.gguf',
      size: data.length,
      sha256: sha,
      quant: 'Q4_K_M',
      shardIndex: null,
      shardCount: null
    }
    await svc.download(file)
    const dest = join(userData, 'models', 'o__r', 'm-Q4_K_M.gguf')
    expect(readFileSync(dest).equals(data)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ done: true, error: null, received: 5000 })
  })

  it('download de grupo baixa todos os shards com o hash de cada um', async () => {
    apiRoutes = {
      '/api/models/o/g/tree/main?recursive=true': [
        { type: 'file', path: 'm-00001-of-00002.gguf', size: 1, lfs: { oid: 'h1', size: 10 } },
        { type: 'file', path: 'm-00002-of-00002.gguf', size: 1, lfs: { oid: 'h2', size: 20 } }
      ]
    }
    const calls: DownloadParams[] = []
    const { svc, userData, progress } = mk(async (p) => {
      calls.push(p)
      p.onProgress({ id: p.id, label: p.label, received: 5, total: null, done: true, error: null })
    })
    await svc.download({
      repo: 'o/g',
      path: 'm-00001-of-00002.gguf',
      size: 30,
      sha256: 'h1',
      quant: null,
      shardIndex: 1,
      shardCount: 2
    })
    expect(calls.map((c) => [c.url, c.dest, c.sha256])).toEqual([
      [
        `${base}/o/g/resolve/main/m-00001-of-00002.gguf`,
        join(userData, 'models', 'o__g', 'm-00001-of-00002.gguf'),
        'h1'
      ],
      [
        `${base}/o/g/resolve/main/m-00002-of-00002.gguf`,
        join(userData, 'models', 'o__g', 'm-00002-of-00002.gguf'),
        'h2'
      ]
    ])
    expect(new Set(calls.map((c) => c.id)).size).toBe(1)
    // progresso agregado: o 1º shard não marca done; o 2º soma o tamanho do 1º
    expect(progress[0]).toMatchObject({ received: 5, total: 30, done: false })
    expect(progress[1]).toMatchObject({ received: 15, total: 30, done: true })
  })

  it('destino rejeita repo/caminho inválidos', () => {
    expect(() => modelDest('/d', 'o/r', '../x.gguf')).toThrow()
    expect(() => modelDest('/d', '../r', 'x.gguf')).toThrow()
    expect(() => modelDest('/d', 'o/r', 'x.bin')).toThrow()
  })

  it('remove só dentro do dir', async () => {
    const { svc, userData } = mk()
    const dir = await svc.dir()
    mkdirSync(join(dir, 'o__r'), { recursive: true })
    const inside = join(dir, 'o__r', 'a.gguf')
    writeFileSync(inside, 'x')
    const outside = join(userData, 'fora.gguf')
    writeFileSync(outside, 'x')
    await expect(svc.remove(outside)).rejects.toThrow(/dentro da pasta/)
    await expect(svc.remove(join(dir, '..', 'fora.gguf'))).rejects.toThrow(/dentro da pasta/)
    await expect(svc.remove(dir)).rejects.toThrow(/dentro da pasta/)
    expect(existsSync(outside)).toBe(true)
    await svc.remove(inside)
    expect(existsSync(inside)).toBe(false)
  })

  it('estimate lê o header do arquivo remoto e usa o hardware', async () => {
    blobs.set('/o/r/resolve/main/moe-Q4_K_M.gguf', buildGguf(QWEN_MOE))
    const { svc } = mk()
    const est = await svc.estimate(
      {
        repo: 'o/r',
        path: 'moe-Q4_K_M.gguf',
        size: 18_556_686_336,
        sha256: null,
        quant: 'Q4_K_M',
        shardIndex: null,
        shardCount: null
      },
      32768,
      'q8_0'
    )
    expect(est.level).toBe('yellow')
    expect(est.note).toMatch(/--n-cpu-moe/)
    const approx = await svc.estimate(
      {
        repo: 'o/r',
        path: 'faltando.gguf',
        size: 1 << 30,
        sha256: null,
        quant: null,
        shardIndex: null,
        shardCount: null
      },
      8192,
      'f16'
    )
    expect(approx.note).toMatch(/aproximada/)
  })
})
