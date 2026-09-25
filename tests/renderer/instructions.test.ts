import { describe, it, expect } from 'vitest'
import type { ActiveInstructions, Instruction } from '@shared/domain'
import {
  activeLabel,
  activeSummary,
  countByKind,
  filterInstructions,
  fromOption,
  isEditable,
  memoryHighlighted,
  mergeById,
  parseGlobs,
  parseIterationsInput,
  parseRuleCommand,
  reasoningChip,
  ruleName,
  ruleSaveParams,
  saveParams,
  sourceLabel,
  suggestionsToPatch,
  thirdPartyOrigins,
  toOption,
  validateDraft,
  visibleInstructions,
  draftFrom,
  DEFAULT_OPTION
} from '../../src/renderer/src/features/instructions/logic'
import {
  applyMention,
  filterMentions,
  mentionQuery,
  withBuiltins,
  RULE_COMMAND
} from '../../src/renderer/src/features/chat/slashCommands'
import {
  applyEngineEvent,
  initialChatState,
  updateMemoryMark
} from '../../src/renderer/src/features/chat/chatStore'

let n = 0
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

describe('visibleInstructions', () => {
  const ctx = {
    projectId: 'p1',
    groupIds: new Set(['g1']),
    chatIds: new Set(['c1'])
  }
  it('mantém globais e só os escopos do projeto selecionado', () => {
    const list = [
      inst({ id: 'g', scope: 'global' }),
      inst({ id: 'p1', scope: 'project', scopeId: 'p1' }),
      inst({ id: 'p2', scope: 'project', scopeId: 'p2' }),
      inst({ id: 'gr1', scope: 'group', scopeId: 'g1' }),
      inst({ id: 'gr2', scope: 'group', scopeId: 'g2' }),
      inst({ id: 'ch1', scope: 'chat', scopeId: 'c1' }),
      inst({ id: 'ch2', scope: 'chat', scopeId: 'c2' })
    ]
    expect(visibleInstructions(list, ctx).map((i) => i.id)).toEqual(['g', 'p1', 'gr1', 'ch1'])
  })
  it('sem projeto mostra tudo', () => {
    const list = [inst({ scope: 'project', scopeId: 'x' })]
    expect(visibleInstructions(list, null)).toHaveLength(1)
  })
})

describe('mergeById / filterInstructions / countByKind', () => {
  it('mescla por id com a última ocorrência vencendo', () => {
    const a = inst({ id: 'x', name: 'velho' })
    const b = inst({ id: 'x', name: 'novo' })
    const c = inst({ id: 'y' })
    expect(mergeById([a, c], [b]).map((i) => i.name)).toEqual(['novo', c.name])
  })
  it('filtra por tipo, escopo e texto; ordena escopo mais específico primeiro', () => {
    const list = [
      inst({ name: 'b', scope: 'global' }),
      inst({ name: 'a', scope: 'chat', scopeId: 'c' }),
      inst({ name: 'c', kind: 'skill' }),
      inst({ name: 'zeta', description: 'testes', scope: 'project', scopeId: 'p' })
    ]
    expect(filterInstructions(list, { kind: 'rule', scope: 'all' }).map((i) => i.name)).toEqual([
      'a',
      'zeta',
      'b'
    ])
    expect(filterInstructions(list, { kind: 'rule', scope: 'global' }).map((i) => i.name)).toEqual([
      'b'
    ])
    expect(
      filterInstructions(list, { kind: 'rule', scope: 'all', query: 'TEST' }).map((i) => i.name)
    ).toEqual(['zeta'])
    expect(countByKind(list)).toEqual({ rule: 3, command: 0, skill: 1, memory: 0 })
  })
  it('memórias: mais recentes primeiro e busca no conteúdo', () => {
    const list = [
      inst({ kind: 'memory', name: 'm1', updatedAt: 1, body: 'usa pnpm' }),
      inst({ kind: 'memory', name: 'm2', updatedAt: 5 })
    ]
    expect(filterInstructions(list, { kind: 'memory', scope: 'all' }).map((i) => i.name)).toEqual([
      'm2',
      'm1'
    ])
    expect(
      filterInstructions(list, { kind: 'memory', scope: 'all', query: 'pnpm' }).map((i) => i.name)
    ).toEqual(['m1'])
  })
})

describe('origem e edição', () => {
  it('só itens do app são editáveis', () => {
    expect(isEditable(inst())).toBe(true)
    expect(
      isEditable(inst({ readonly: true, source: { type: 'file', path: '/a/AGENTS.md' } }))
    ).toBe(false)
  })
  it('rótulos de origem', () => {
    expect(sourceLabel({ type: 'file', path: 'C:\\x\\CLAUDE.md' })).toBe('CLAUDE.md')
    expect(sourceLabel({ type: 'plugin', marketplace: 'mk', plugin: 'pl', path: '/p' })).toBe(
      'plugin pl@mk'
    )
    expect(
      sourceLabel({
        type: 'github',
        url: 'https://github.com/o/r',
        ref: 'main',
        path: 'x.md',
        sha: 'abc'
      })
    ).toBe('GitHub o/r')
  })
  it('terceiros das memórias, com contagem e nome quando conhecido', () => {
    const gh = inst({
      id: 'gh1',
      name: 'estilo',
      readonly: true,
      source: { type: 'github', url: 'https://github.com/o/r', ref: 'main', path: 'a', sha: 's' }
    })
    const mems = [
      inst({
        kind: 'memory',
        origin: { chatId: 'c', requestId: null, thirdParty: ['gh1', 'gh1'] }
      }),
      inst({ kind: 'memory', origin: { chatId: 'c', requestId: null, thirdParty: ['gh1', 'zz'] } }),
      inst({ kind: 'memory' })
    ]
    const r = thirdPartyOrigins(mems, [gh])
    expect(r[0]).toEqual({ id: 'gh1', label: 'estilo (GitHub o/r)', count: 2 })
    expect(r[1].id).toBe('zz')
    expect(r[1].count).toBe(1)
    expect(r[1].label).toContain('removida')
  })
  it('valida e monta o save', () => {
    const d = draftFrom(inst({ id: 'x', name: 'ok', trigger: 'glob', globs: [] }))
    expect(validateDraft(d)).toMatch(/padrão/)
    expect(validateDraft({ ...d, name: 'com espaço' })).toMatch(/espaços/)
    expect(validateDraft({ ...d, kind: 'memory', name: 'com espaço', trigger: 'always' })).toBe(
      null
    )
    const globs = parseGlobs('src/**/*.ts, *.md\n*.md')
    expect(globs).toEqual(['src/**/*.ts', '*.md'])
    expect(saveParams({ ...d, globs, name: ' ok ' })).toMatchObject({
      id: 'x',
      name: 'ok',
      globs,
      scopeId: null
    })
    expect(saveParams({ ...d, trigger: 'always', globs }).globs).toEqual([])
  })
})

describe('/regra', () => {
  it('reconhece o comando', () => {
    expect(parseRuleCommand('/regra responda em pt')).toBe('responda em pt')
    expect(parseRuleCommand('/regra')).toBe('')
    expect(parseRuleCommand('/regras x')).toBeNull()
    expect(parseRuleCommand('oi /regra x')).toBeNull()
  })
  it('gera nome e params de regra do chat', () => {
    expect(ruleName('Sempre responda em Português, por favor!')).toBe(
      'sempre-responda-em-portugues-por-favor'
    )
    expect(ruleName('!!!', 36)).toBe('regra-10')
    expect(ruleSaveParams('c1', ' use tabs ')).toMatchObject({
      kind: 'rule',
      scope: 'chat',
      scopeId: 'c1',
      trigger: 'always',
      body: 'use tabs'
    })
  })
  it('sugestões aceitas viram patch de chats.update', () => {
    expect(suggestionsToPatch([])).toBeNull()
    expect(
      suggestionsToPatch([
        { key: 'reasoning', value: 'high', label: '' },
        { key: 'subagentCombo', value: 'leve', label: '' },
        { key: 'subagentReasoning', value: 'bogus', label: '' },
        { key: 'tokenBudget', value: 200000, label: '' },
        { key: 'maxIterations', value: null, label: '' }
      ])
    ).toEqual({
      settings: { reasoning: 'high', subagentCombo: 'leve', subagentReasoning: null },
      tokenBudget: 200000,
      maxIterations: null
    })
  })
  it('o /regra aparece no menu, sem duplicar', () => {
    const list = withBuiltins([
      { ...RULE_COMMAND, path: '/x' },
      { ...RULE_COMMAND, name: 'a' }
    ])
    expect(list.map((c) => c.name)).toEqual(['regra', 'a'])
    expect(list[0].path).toBe('')
  })
})

describe('@nome', () => {
  it('detecta menção sendo digitada no fim', () => {
    expect(mentionQuery('@')).toBe('')
    expect(mentionQuery('use @rev')).toBe('rev')
    expect(mentionQuery('email@x')).toBeNull()
    expect(mentionQuery('@rev ')).toBeNull()
  })
  it('aplica e filtra', () => {
    expect(applyMention('olha @re', 'review')).toBe('olha @review ')
    expect(applyMention('@', 'x')).toBe('@x ')
    const items = [
      { name: 'review', description: '', scope: 'global' },
      { name: 'prereview', description: '', scope: 'global' },
      { name: 'x', description: 'faz review', scope: 'chat' }
    ]
    expect(filterMentions(items, 'review').map((m) => m.name)).toEqual(['review', 'prereview', 'x'])
  })
})

describe('ajustes e indicador', () => {
  it('opções do select e limite de iterações', () => {
    expect(toOption(null)).toBe(DEFAULT_OPTION)
    expect(fromOption(DEFAULT_OPTION)).toBeNull()
    expect(fromOption('low')).toBe('low')
    expect(parseIterationsInput('')).toBeNull()
    expect(parseIterationsInput('30')).toBe(30)
    expect(parseIterationsInput('0')).toBeUndefined()
    expect(parseIterationsInput('1.5')).toBeUndefined()
  })
  it('chip de reasoning', () => {
    expect(reasoningChip(null)).toBeNull()
    expect(reasoningChip({ requested: null, confirmed: true })).toBeNull()
    expect(reasoningChip({ requested: 'low', confirmed: false })).toEqual({
      text: 'reasoning: low · não confirmado',
      confirmed: false
    })
  })
  it('resumo das ativas', () => {
    const a: ActiveInstructions = {
      chatId: 'c',
      alwaysTokens: 9000,
      alwaysBudget: 8000,
      overBudget: true,
      items: [
        {
          id: '1',
          name: 'a',
          kind: 'rule',
          scope: 'global',
          trigger: 'always',
          reason: '',
          tokens: 1,
          included: 'content'
        },
        {
          id: '2',
          name: 'b',
          kind: 'skill',
          scope: 'global',
          trigger: 'model',
          reason: '',
          tokens: 1,
          included: 'listed'
        },
        {
          id: '3',
          name: 'c',
          kind: 'rule',
          scope: 'global',
          trigger: 'always',
          reason: '',
          tokens: 1,
          included: 'dropped'
        }
      ]
    }
    expect(activeSummary(a)).toEqual({ count: 2, dropped: 1, overBudget: true })
    expect(activeSummary(null)).toEqual({ count: 0, dropped: 0, overBudget: false })
    expect(activeLabel(1)).toBe('1 instrução ativa')
    expect(activeLabel(3)).toBe('3 instruções ativas')
  })
  it('destaque de memória por 15 s', () => {
    expect(memoryHighlighted(1000, 15_999)).toBe(true)
    expect(memoryHighlighted(1000, 16_000)).toBe(false)
  })
})

describe('chatStore: memory_saved e reasoning_status', () => {
  it('guarda o card, atualiza pelo toolCallId e marca desfeito', () => {
    const m = inst({ kind: 'memory', name: 'pnpm' })
    let s = applyEngineEvent(
      initialChatState(),
      { type: 'memory_saved', chatId: 'c', instruction: m, toolCallId: 't1', created: true },
      'c',
      100
    )
    expect(s.memories).toEqual([
      { toolCallId: 't1', instruction: m, created: true, at: 100, afterSeq: 0, undone: false }
    ])
    // Outro chat: ignorado.
    expect(
      applyEngineEvent(
        s,
        { type: 'memory_saved', chatId: 'x', instruction: m, toolCallId: 't2', created: true },
        'c'
      )
    ).toBe(s)
    const m2 = { ...m, body: 'novo' }
    s = applyEngineEvent(
      s,
      { type: 'memory_saved', chatId: 'c', instruction: m2, toolCallId: 't1', created: false },
      'c',
      200
    )
    expect(s.memories).toHaveLength(1)
    expect(s.memories[0]).toMatchObject({ created: false, at: 200, instruction: m2 })
    s = updateMemoryMark(s, 't1', { undone: true })
    expect(s.memories[0].undone).toBe(true)
    expect(updateMemoryMark(s, 'nada', { undone: true })).toBe(s)
  })
  it('reasoning_status vira o último status', () => {
    const s = applyEngineEvent(
      initialChatState(),
      { type: 'reasoning_status', chatId: 'c', requestId: 'r', requested: 'high', confirmed: true },
      'c'
    )
    expect(s.reasoning).toEqual({ requestId: 'r', requested: 'high', confirmed: true })
  })
})
