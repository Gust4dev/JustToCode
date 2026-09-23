import { describe, it, expect, beforeEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobStore } from '../../src/agent-host/blobs'
import { PathError, resolveInside } from '../../src/agent-host/tools/pathGuard'
import { rgPath } from '../../src/agent-host/tools/ripgrep'
import { fileTools } from '../../src/agent-host/tools'
import type { Tool, ToolContext } from '../../src/agent-host/tools/types'
import type { CaptureMeta, ChangeCapture } from '../../src/agent-host/services/types'

interface WriteCall {
  meta: CaptureMeta
  rel: string
  before: Buffer | null
  after: Buffer | null
}

const tool = (name: string): Tool => {
  const t = fileTools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

let root: string
let calls: WriteCall[]
let ctx: ToolContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jtc-tools-'))
  calls = []
  const capture: ChangeCapture = {
    recordToolWrite(meta, rel, before, after) {
      calls.push({ meta, rel, before, after })
      return null
    },
    async withCommand(_m, fn) {
      return { result: await fn(), changes: [] }
    }
  }
  ctx = {
    projectId: 'p1',
    projectRoot: root,
    chatId: 'c1',
    toolCallId: 't1',
    signal: new AbortController().signal,
    blobs: new BlobStore(mkdtempSync(join(tmpdir(), 'jtc-tools-blobs-'))),
    capture,
    config: { shell: 'auto', shellTimeoutMs: 1000 },
    onOutput: () => {}
  }
})

describe('resolveInside', () => {
  it('aceita caminho interno e devolve rel com /', () => {
    const r = resolveInside(root, 'src\\a\\b.ts')
    expect(r.rel).toBe('src/a/b.ts')
    expect(r.abs).toBe(join(root, 'src', 'a', 'b.ts'))
  })

  it('rejeita ../x', () => {
    expect(() => resolveInside(root, '../x')).toThrow(PathError)
  })

  it('rejeita caminho absoluto fora', () => {
    expect(() => resolveInside(root, join(tmpdir(), 'outro.txt'))).toThrow(PathError)
  })

  it('rejeita junction apontando para fora', () => {
    const outside = mkdtempSync(join(tmpdir(), 'jtc-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'x')
    symlinkSync(outside, join(root, 'link'), 'junction')
    expect(() => resolveInside(root, 'link/secret.txt')).toThrow(PathError)
    expect(() => resolveInside(root, 'link/novo/arquivo.txt')).toThrow(PathError)
  })
})

describe('rgPath', () => {
  it('aponta para um binário existente', () => {
    expect(existsSync(rgPath())).toBe(true)
  })
})

describe('read_file', () => {
  it('formato cat -n com offset/limit', async () => {
    writeFileSync(join(root, 'a.txt'), 'l1\r\nl2\r\nl3\r\nl4\r\n')
    const r = await tool('read_file').run({ path: 'a.txt', offset: 2, limit: 2 }, ctx)
    expect(r.isError).toBeFalsy()
    const lines = r.content.split('\n')
    expect(lines[0]).toBe('     2\tl2')
    expect(lines[1]).toBe('     3\tl3')
    expect(lines[2]).toContain('offset=4')
  })

  it('rejeita binário', async () => {
    writeFileSync(join(root, 'b.bin'), Buffer.from([1, 0, 2]))
    const r = await tool('read_file').run({ path: 'b.bin' }, ctx)
    expect(r.isError).toBe(true)
  })

  it('imagem vai para o blob', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0])
    writeFileSync(join(root, 'img.png'), png)
    const r = await tool('read_file').run({ path: 'img.png' }, ctx)
    expect(r.content).toBe('Image attached: img.png')
    expect(r.images).toHaveLength(1)
    expect(r.images![0].mime).toBe('image/png')
    expect(ctx.blobs.get(r.images![0].blobHash)?.equals(png)).toBe(true)
  })

  it('arquivo > 2 MB sem range dá erro', async () => {
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(2 * 1024 * 1024 + 10))
    const r = await tool('read_file').run({ path: 'big.txt' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('offset')
  })
})

describe('write_file', () => {
  it('cria pastas e registra capture com before=null', async () => {
    const r = await tool('write_file').run({ path: 'novo/dir/x.ts', content: 'a\nb\n' }, ctx)
    expect(r.content).toBe('Wrote 2 lines to novo/dir/x.ts')
    expect(readFileSync(join(root, 'novo', 'dir', 'x.ts'), 'utf8')).toBe('a\nb\n')
    expect(calls).toHaveLength(1)
    expect(calls[0].rel).toBe('novo/dir/x.ts')
    expect(calls[0].before).toBeNull()
    expect(calls[0].after?.toString()).toBe('a\nb\n')
    expect(calls[0].meta).toEqual({
      projectId: 'p1',
      projectRoot: root,
      chatId: 'c1',
      toolCallId: 't1'
    })
  })

  it('recusa caminho fora da raiz', async () => {
    const r = await tool('write_file').run({ path: '../fora.txt', content: 'x' }, ctx)
    expect(r.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('edit_file', () => {
  const edit = (args: Record<string, unknown>): ReturnType<Tool['run']> =>
    tool('edit_file').run({ path: 'e.txt', ...args }, ctx)

  it('erro: arquivo não existe', async () => {
    const r = await edit({ old_string: 'a', new_string: 'b' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain('not found')
  })

  it('erro: old_string não encontrado', async () => {
    writeFileSync(join(root, 'e.txt'), 'abc')
    const r = await edit({ old_string: 'zzz', new_string: 'b' })
    expect(r.isError).toBe(true)
  })

  it('erro: strings iguais', async () => {
    writeFileSync(join(root, 'e.txt'), 'abc')
    const r = await edit({ old_string: 'a', new_string: 'a' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain('identical')
  })

  it('erro: múltiplas ocorrências sem replace_all diz quantas', async () => {
    writeFileSync(join(root, 'e.txt'), 'x x x')
    const r = await edit({ old_string: 'x', new_string: 'y' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain('3 times')
    expect(calls).toHaveLength(0)
  })

  it('sucesso com replace_all', async () => {
    writeFileSync(join(root, 'e.txt'), 'x x x')
    const r = await edit({ old_string: 'x', new_string: 'y', replace_all: true })
    expect(r.content).toBe('Edited e.txt (3 replacement(s))')
    expect(readFileSync(join(root, 'e.txt'), 'utf8')).toBe('y y y')
    expect(calls[0].before?.toString()).toBe('x x x')
    expect(calls[0].after?.toString()).toBe('y y y')
  })

  it('preserva CRLF', async () => {
    writeFileSync(join(root, 'e.txt'), 'a\r\nb\r\nc\r\n')
    const r = await edit({ old_string: 'a\nb', new_string: 'a\nX\nb' })
    expect(r.content).toBe('Edited e.txt (1 replacement(s))')
    expect(readFileSync(join(root, 'e.txt'), 'utf8')).toBe('a\r\nX\r\nb\r\nc\r\n')
  })
})

describe('glob', () => {
  it('respeita .gitignore', async () => {
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, '.gitignore'), 'dist/\n')
    writeFileSync(join(root, 'src', 'a.ts'), '')
    writeFileSync(join(root, 'src', 'b.js'), '')
    writeFileSync(join(root, 'dist', 'c.ts'), '')
    const r = await tool('glob').run({ pattern: '**/*.ts' }, ctx)
    expect(r.content).toBe('src/a.ts')
    const sub = await tool('glob').run({ pattern: '*.js', path: 'src' }, ctx)
    expect(sub.content).toBe('src/b.js')
    const none = await tool('glob').run({ pattern: '*.md' }, ctx)
    expect(none.content).toBe('(no matches)')
  })
})

describe('grep', () => {
  beforeEach(() => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'const x = useAuth()\nother\n')
    writeFileSync(join(root, 'src', 'b.ts'), 'nothing here\n')
    writeFileSync(join(root, 'readme.md'), 'USEAUTH docs\n')
  })

  it('modo files_with_matches', async () => {
    const r = await tool('grep').run({ pattern: 'useAuth' }, ctx)
    expect(r.content).toBe('src/a.ts')
    const ci = await tool('grep').run({ pattern: 'useauth', case_insensitive: true }, ctx)
    expect(ci.content.split('\n')).toEqual(['readme.md', 'src/a.ts'])
    const g = await tool('grep').run(
      { pattern: 'useauth', case_insensitive: true, glob: '*.md' },
      ctx
    )
    expect(g.content).toBe('readme.md')
  })

  it('modo content', async () => {
    const r = await tool('grep').run({ pattern: 'useAuth', output_mode: 'content' }, ctx)
    expect(r.content).toBe('src/a.ts:1:const x = useAuth()')
    const sub = await tool('grep').run(
      { pattern: 'useAuth', path: 'src', output_mode: 'content', context: 1 },
      ctx
    )
    expect(sub.content.split('\n')).toEqual(['src/a.ts:1:const x = useAuth()', 'src/a.ts-2-other'])
    const none = await tool('grep').run({ pattern: 'zzz' }, ctx)
    expect(none.content).toBe('(no matches)')
  })
})

describe('list_dir', () => {
  it('lista ordenado, pastas com / e ignora .git', async () => {
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'b.txt'), '')
    writeFileSync(join(root, 'a.txt'), '')
    writeFileSync(join(root, 'src', 'x.ts'), '')
    const r = await tool('list_dir').run({}, ctx)
    expect(r.content.split('\n')).toEqual(['a.txt', 'b.txt', 'src/'])
    const sub = await tool('list_dir').run({ path: 'src' }, ctx)
    expect(sub.content).toBe('x.ts')
  })
})

describe('summarize', () => {
  it('textos curtos', () => {
    expect(tool('read_file').summarize({ path: 'src/a.ts' })).toBe('read src/a.ts')
    expect(tool('write_file').summarize({ path: 'src/a.ts' })).toBe('write src/a.ts')
    expect(tool('edit_file').summarize({ path: 'src/a.ts' })).toBe('edit src/a.ts')
    expect(tool('glob').summarize({ pattern: '**/*.ts' })).toBe('glob **/*.ts')
    expect(tool('grep').summarize({ pattern: 'useAuth' })).toBe('grep "useAuth"')
    expect(tool('list_dir').summarize({ path: 'src' })).toBe('ls src')
  })
})
