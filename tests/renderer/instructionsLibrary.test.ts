import { describe, it, expect } from 'vitest'
import type { InstallPreview, InstallPreviewItem, Instruction } from '@shared/domain'
import {
  batchToggleTargets,
  changeDraftKind,
  changeDraftScope,
  defaultTargetId,
  describeSuspicious,
  diffStats,
  exportErrorMessage,
  groupByPlugin,
  groupToggleState,
  initialSelection,
  installParams,
  lineDiff,
  markContent,
  newDraft,
  previewItemFor,
  scopeOptions,
  selectAll,
  splitSuspiciousName,
  stripFrontmatter,
  toggleSelection,
  updateDiff,
  updateParams,
  type ScopeTargetContext
} from '../../src/renderer/src/features/instructions/libraryLogic'
import { draftFrom, saveParams } from '../../src/renderer/src/features/instructions/logic'

let n = 0
const ZW = String.fromCharCode(0x200b)
const inst = (p: Partial<Instruction> = {}): Instruction => ({
  id: p.id ?? `i${++n}`,
  kind: 'rule',
  scope: 'global',
  scopeId: null,
  name: `item${n}`,
  description: '',
  trigger: 'always',
  globs: [],
  body: 'corpo',
  format: 'md',
  source: { type: 'app' },
  enabled: true,
  readonly: false,
  origin: null,
  createdAt: 1,
  updatedAt: 1,
  ...p
})

const pitem = (p: Partial<InstallPreviewItem> = {}): InstallPreviewItem => ({
  path: 'skills/a/SKILL.md',
  kind: 'skill',
  name: 'a',
  format: 'md',
  content: 'oi',
  suspicious: [],
  ...p
})

const SHA = 'b'.repeat(40)
const preview = (items: InstallPreviewItem[]): InstallPreview => ({
  url: 'https://github.com/o/r',
  ref: 'main',
  sha: SHA,
  items
})

const ctx: ScopeTargetContext = {
  project: { id: 'p1', name: 'Proj' },
  groups: [{ id: 'g1', name: 'Grupo' }],
  chats: [
    { id: 'c1', title: 'Um' },
    { id: 'c2', title: '' }
  ],
  chatId: 'c2'
}

describe('escopo + alvo', () => {
  it('lista escopos com alvos do projeto atual', () => {
    const o = scopeOptions(ctx)
    expect(o.map((x) => x.scope)).toEqual(['global', 'project', 'group', 'chat'])
    expect(o[3].targets[1].label).toBe('Sem título')
    expect(scopeOptions({ project: null, groups: [], chats: [], chatId: null })).toHaveLength(1)
    expect(scopeOptions({ ...ctx, groups: [] }).some((x) => x.scope === 'group')).toBe(false)
  })
  it('escolhe alvo padrão (chat aberto, atual válido, primeiro)', () => {
    expect(defaultTargetId('global', ctx)).toBeNull()
    expect(defaultTargetId('chat', ctx)).toBe('c2')
    expect(defaultTargetId('chat', ctx, 'c1')).toBe('c1')
    expect(defaultTargetId('chat', ctx, 'zz')).toBe('c2')
    expect(defaultTargetId('group', ctx)).toBe('g1')
    expect(defaultTargetId('project', { ...ctx, project: null })).toBeNull()
  })
  it('novo rascunho e trocas de tipo/escopo', () => {
    const d = newDraft('command', ctx)
    expect(d).toMatchObject({ kind: 'command', scope: 'project', scopeId: 'p1', trigger: 'manual' })
    expect(d.format).toBe('md')
    expect(newDraft('rule', { ...ctx, project: null })).toMatchObject({
      scope: 'global',
      scopeId: null
    })
    // gatilho acompanha o padrão; gatilho escolhido é mantido
    expect(changeDraftKind(d, 'skill').trigger).toBe('model')
    expect(changeDraftKind({ ...d, trigger: 'glob' }, 'rule').trigger).toBe('glob')
    expect(changeDraftKind({ ...d, format: 'toml' }, 'memory')).toMatchObject({
      trigger: 'always',
      format: 'md'
    })
    expect(changeDraftScope(d, 'chat', ctx).scopeId).toBe('c2')
    expect(changeDraftScope(d, 'global', ctx).scopeId).toBeNull()
  })
  it('formato vai para o save e volta do item', () => {
    const d = draftFrom(inst({ id: 'x', name: 'n', format: 'toml' }))
    expect(d.format).toBe('toml')
    expect(saveParams(d).format).toBe('toml')
    expect(saveParams({ ...d, kind: 'memory' }).format).toBe('md')
  })
  it('mensagens de export', () => {
    expect(exportErrorMessage('EXISTS', 'x')).toMatch(/já existe/)
    expect(exportErrorMessage('READONLY', 'x')).toMatch(/criados no app/)
    expect(exportErrorMessage('OUTRO', 'boom')).toMatch(/boom/)
  })
})

describe('instalar do GitHub', () => {
  const ok = pitem({ path: 'commands/ok.md', kind: 'command', name: 'ok' })
  const bad = pitem({
    path: 'skills/bad/SKILL.md',
    name: 'bad',
    content: ['linha 1', `ab${ZW}c`].join('\n'),
    suspicious: [{ line: 2, col: 3, codepoint: 'U+200B', name: 'ZERO WIDTH SPACE' }]
  })
  const p = preview([ok, bad])

  it('item com suspeito começa desmarcado e não pode ser marcado', () => {
    const sel = initialSelection(p)
    expect([...sel]).toEqual(['commands/ok.md'])
    expect(toggleSelection(sel, bad, true).has(bad.path)).toBe(false)
    expect(toggleSelection(sel, ok, false).size).toBe(0)
    expect(selectAll(p, true).size).toBe(1)
    expect(selectAll(p, false).size).toBe(0)
  })
  it('monta os parâmetros de instalação', () => {
    expect(installParams(p, new Set([ok.path, bad.path]), 'project', 'p1')).toEqual({
      url: p.url,
      ref: 'main',
      sha: SHA,
      paths: ['commands/ok.md'],
      scope: 'project',
      scopeId: 'p1'
    })
    expect(installParams(p, new Set([ok.path]), 'global', 'p1')?.scopeId).toBeNull()
    expect(installParams(p, new Set([ok.path]), 'chat', null)).toBeNull()
    expect(installParams(p, new Set([bad.path]), 'global', null)).toBeNull()
  })
  it('descreve e destaca suspeitos (inclusive de arquivo de apoio)', () => {
    expect(splitSuspiciousName('ZERO WIDTH SPACE')).toEqual({
      file: null,
      name: 'ZERO WIDTH SPACE'
    })
    expect(splitSuspiciousName('skills/x/ref.md: TAG CHARACTER')).toEqual({
      file: 'skills/x/ref.md',
      name: 'TAG CHARACTER'
    })
    expect(describeSuspicious(bad.suspicious[0])).toBe('linha 2, coluna 3: U+200B ZERO WIDTH SPACE')
    expect(
      describeSuspicious({ line: 1, col: 1, codepoint: 'U+E0041', name: 'ref.md: TAG CHARACTER' })
    ).toMatch(/\(em ref\.md\)$/)
    const lines = markContent(bad.content, [
      ...bad.suspicious,
      { line: 1, col: 1, codepoint: 'U+E0041', name: 'ref.md: TAG CHARACTER' }
    ])
    expect(lines[0].flagged).toBe(false)
    expect(lines[1].flagged).toBe(true)
    expect(lines[1].segments).toEqual([
      { text: 'ab' },
      { text: ZW, suspicious: 'U+200B', name: 'ZERO WIDTH SPACE' },
      { text: 'c' }
    ])
  })
  it('coluna conta codepoints (astral)', () => {
    const tag = String.fromCodePoint(0xe0041)
    const l = markContent(`😀${tag}x`, [
      { line: 1, col: 2, codepoint: 'U+E0041', name: 'TAG CHARACTER' }
    ])
    expect(l[0].segments.map((s) => s.suspicious ?? s.text)).toEqual(['😀', 'U+E0041', 'x'])
  })
})

describe('verificar atualização', () => {
  const gh = inst({
    id: 'gh',
    kind: 'skill',
    scope: 'project',
    scopeId: 'p1',
    body: 'a\nb\nc',
    readonly: true,
    source: {
      type: 'github',
      url: 'https://github.com/o/r',
      ref: 'main',
      path: 'x/SKILL.md',
      sha: 'a'.repeat(40)
    }
  })
  it('tira frontmatter', () => {
    expect(stripFrontmatter('---\nname: x\n---\ncorpo\n')).toBe('corpo\n')
    expect(stripFrontmatter('---\r\nname: x\r\n---\r\ncorpo')).toBe('corpo')
    expect(stripFrontmatter('sem frontmatter')).toBe('sem frontmatter')
  })
  it('diff de linhas', () => {
    const d = lineDiff('a\nb\nc', 'a\nc\nd')
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'same', text: 'c' },
      { type: 'add', text: 'd' }
    ])
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 })
  })
  it('acha o item pelo caminho e monta o diff/atualização', () => {
    const item = pitem({ path: 'x/SKILL.md', content: '---\nname: s\n---\na\nb\nd\n' })
    const p = preview([pitem({ path: 'outro.md' }), item])
    expect(previewItemFor(gh, p)).toBe(item)
    expect(previewItemFor(gh, preview([pitem({ path: 'z' }), pitem({ path: 'y' })]))).toBeNull()
    expect(diffStats(updateDiff(gh, item))).toEqual({ added: 1, removed: 1 })
    expect(updateParams(gh, p, item)).toEqual({
      url: 'https://github.com/o/r',
      ref: 'main',
      sha: SHA,
      paths: ['x/SKILL.md'],
      scope: 'project',
      scopeId: 'p1'
    })
    expect(
      updateParams(gh, p, {
        ...item,
        suspicious: [{ line: 1, col: 1, codepoint: 'U+202E', name: 'RIGHT-TO-LEFT OVERRIDE' }]
      })
    ).toBeNull()
    expect(updateParams(inst(), p, item)).toBeNull()
  })
})

describe('plugins agrupados', () => {
  const plug = (plugin: string, enabled: boolean): Instruction =>
    inst({
      kind: 'skill',
      enabled,
      readonly: true,
      source: { type: 'plugin', marketplace: 'mk', plugin, path: `/p/${plugin}` }
    })
  it('agrupa por plugin e calcula o toggle em lote', () => {
    const a1 = plug('b-plugin', true)
    const a2 = plug('b-plugin', false)
    const b1 = plug('a-plugin', true)
    const app = inst({ kind: 'skill' })
    const { groups, rest } = groupByPlugin([a1, app, a2, b1])
    expect(groups.map((g) => g.key)).toEqual(['a-plugin@mk', 'b-plugin@mk'])
    expect(rest).toEqual([app])
    expect(groupToggleState(groups[0])).toBe('on')
    expect(groupToggleState(groups[1])).toBe('mixed')
    expect(batchToggleTargets(groups[1], true)).toEqual([a2])
    expect(batchToggleTargets(groups[1], false)).toEqual([a1])
    expect(groupToggleState({ ...groups[1], enabled: 0 })).toBe('off')
  })
})
