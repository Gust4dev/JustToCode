import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type Instruction,
  type Project
} from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import { openDb, type Db } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { ProjectRepo } from '../../src/agent-host/repo/projects'
import { ChatRepo } from '../../src/agent-host/repo/chats'
import { InstructionRepo } from '../../src/agent-host/repo/instructions'
import { TouchedPathRepo } from '../../src/agent-host/repo/touchedPaths'
import { matchesGlob } from '../../src/agent-host/ecosystem/glob'
import {
  discoverInstructions,
  stableInstructionId
} from '../../src/agent-host/ecosystem/instructionSources'
import {
  createInstructionResolver,
  mentionedNames,
  resolveInstructions
} from '../../src/agent-host/ecosystem/resolver'
import { loadInstructions } from '../../src/agent-host/ecosystem/instructions'
import { discoverSkills } from '../../src/agent-host/ecosystem/skills'
import { discoverAgents } from '../../src/agent-host/ecosystem/agents'
import { shellLabel, systemFor } from '../../src/agent-host/engine/turn'
import { buildSystemPrompt } from '../../src/agent-host/engine/systemPrompt'
import { instructionHandlers } from '../../src/agent-host/handlers/instructions'
import { createServices } from '../../src/agent-host/services'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { chunk, startFakeRouter, type FakeRouter } from '../helpers/fakeRouter'

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const skill = (root: string, dir: string, fm: string, body = 'Skill body.'): string =>
  write(join(root, dir, 'SKILL.md'), `---\n${fm}\n---\n${body}\n`)

interface Env {
  base: string
  home: string
  project: string
  cfg: AppConfig
  db: Db
}

function setup(): Env {
  const base = mkdtempSync(join(tmpdir(), 'jtc-instr-'))
  const home = join(base, 'home')
  const project = join(base, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    instructionFiles: [join(home, '.claude/CLAUDE.md'), join(home, '.codex/AGENTS.md')],
    skillRoots: [join(home, '.claude/skills')],
    commandRoots: [join(home, '.claude/commands')],
    agentRoots: [join(home, '.claude/agents')],
    pluginRoots: [join(home, '.claude/plugins/cache')],
    ruleRoots: [join(home, '.claude/rules')]
  }
  const db = openDb(join(base, 'db.sqlite'))
  return { base, home, project, cfg, db }
}

let env: Env
const routers: FakeRouter[] = []
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  env.db.close()
  while (routers.length) await routers.pop()?.close()
})

const inst = (p: Partial<Instruction> & Pick<Instruction, 'name'>): Instruction => ({
  id: p.id ?? `${p.scope ?? 'global'}:${p.name}`,
  kind: 'rule',
  scope: 'global',
  scopeId: null,
  description: '',
  trigger: 'always',
  globs: [],
  body: `body of ${p.name}`,
  format: 'md',
  source: { type: 'app' },
  enabled: true,
  readonly: false,
  origin: null,
  createdAt: 0,
  updatedAt: 0,
  ...p
})

const opts = {
  chatId: 'c',
  touchedPaths: [] as string[],
  manualNames: [] as string[],
  budget: 8000
}

describe('glob', () => {
  it('**, *, ?, {a,b}, [..], barras do Windows e padrão sem / casando em qualquer pasta', () => {
    expect(matchesGlob('src/a.ts', '*.ts')).toBe(true)
    expect(matchesGlob('src\\deep\\a.ts', 'src/**/*.ts')).toBe(true)
    expect(matchesGlob('src/a.ts', 'src/**/*.ts')).toBe(true)
    expect(matchesGlob('lib/a.ts', 'src/**/*.ts')).toBe(false)
    expect(matchesGlob('src/a.tsx', 'src/*.{ts,tsx}')).toBe(true)
    expect(matchesGlob('src/sub/a.ts', 'src/*.ts')).toBe(false)
    expect(matchesGlob('a1.md', 'a?.md')).toBe(true)
    expect(matchesGlob('ab.md', 'a[0-9].md')).toBe(false)
    expect(matchesGlob('docs/x.md', 'docs/**')).toBe(true)
    expect(matchesGlob('SRC/A.TS', 'src/*.ts')).toBe(true)
    expect(matchesGlob('a.ts', '')).toBe(false)
    expect(matchesGlob('a.ts.bak', '*.ts')).toBe(false)
  })
})

describe('resolveInstructions (puro)', () => {
  it('precedência chat > grupo > projeto > global pelo nome (por tipo)', () => {
    const r = resolveInstructions(
      [
        inst({ name: 'style', scope: 'global', body: 'G' }),
        inst({ name: 'style', scope: 'chat', scopeId: 'c', body: 'C' }),
        inst({ name: 'style', scope: 'project', scopeId: 'p', body: 'P' }),
        inst({ name: 'style', scope: 'group', scopeId: 'g', body: 'GR' }),
        inst({ name: 'other', scope: 'project', scopeId: 'p', body: 'O' }),
        inst({ name: 'style', kind: 'skill', trigger: 'model', description: 'd' })
      ],
      opts
    )
    expect(r.always.map((i) => i.body)).toEqual(['O', 'C'])
    expect(r.listed.map((i) => i.name)).toEqual(['style'])
  })

  it('orçamento corta os de menor precedência e marca dropped', () => {
    const big = 'palavra '.repeat(400)
    const r = resolveInstructions(
      [
        inst({ name: 'g', scope: 'global', body: big }),
        inst({ name: 'p', scope: 'project', scopeId: 'p', body: big }),
        inst({ name: 'c', scope: 'chat', scopeId: 'c', body: 'curta' })
      ],
      { ...opts, budget: 500 }
    )
    expect(r.always.map((i) => i.name)).toEqual(['p', 'c'])
    const g = r.active.items.find((i) => i.name === 'g')
    expect(g?.included).toBe('dropped')
    expect(r.active.overBudget).toBe(true)
    expect(r.active.alwaysBudget).toBe(500)
    expect(r.active.alwaysTokens).toBeLessThanOrEqual(500)
    expect(r.active.alwaysTokens).toBeGreaterThan(0)
  })

  it('desligados e memórias não entram; model só listado; manual só citado', () => {
    const r = resolveInstructions(
      [
        inst({ name: 'off', enabled: false }),
        inst({ name: 'mem', kind: 'memory' }),
        inst({ name: 'sk', kind: 'skill', trigger: 'model', description: 'x' }),
        inst({ name: 'cmd', kind: 'command', trigger: 'manual' }),
        inst({ name: 'cmd2', kind: 'command', trigger: 'manual' })
      ],
      { ...opts, manualNames: ['cmd'] }
    )
    expect(r.always).toEqual([])
    expect(r.listed.map((i) => i.name)).toEqual(['sk'])
    expect(r.manual.map((i) => i.name)).toEqual(['cmd'])
    expect(r.active.items.map((i) => [i.name, i.included])).toEqual([
      ['sk', 'listed'],
      ['cmd', 'content']
    ])
  })

  it('mentionedNames: @nome e /nome só como palavra inteira', () => {
    const known = ['review', 'ts:strict', 'rev']
    expect(mentionedNames('use @review please', known)).toEqual(['review'])
    expect(mentionedNames('/ts:strict agora', known)).toEqual(['ts:strict'])
    expect(mentionedNames('email a@review.com e src/review', known)).toEqual([])
    expect(mentionedNames('@reviewer', known)).toEqual([])
    expect(mentionedNames('ver @rev.', known)).toEqual(['rev'])
  })
})

describe('descobertos como Instruction', () => {
  it('ids estáveis, readonly, tipos/gatilhos e fonte de plugin', () => {
    const { home, project, cfg } = env
    const claude = write(join(home, '.claude/CLAUDE.md'), 'Global rule.')
    const agents = write(join(project, 'AGENTS.md'), 'Project rule.')
    skill(join(home, '.claude/skills'), 'tdd', 'name: tdd\ndescription: tests first')
    skill(
      join(home, '.claude/plugins/cache/market/plug/1.0.0/skills'),
      'brain',
      'name: brain\ndescription: plugin skill'
    )
    write(join(home, '.claude/commands/review.md'), '---\ndescription: review\n---\nReview it.')

    const a = discoverInstructions(project, 'P1', cfg)
    const b = discoverInstructions(project, 'P1', cfg)
    expect(b.map((i) => i.id)).toEqual(a.map((i) => i.id))
    const byName = new Map(a.map((i) => [i.name, i]))
    expect(byName.get(claude)).toMatchObject({
      kind: 'rule',
      trigger: 'always',
      scope: 'global',
      readonly: true,
      body: 'Global rule.',
      id: stableInstructionId('file', claude)
    })
    expect(byName.get(agents)).toMatchObject({ scope: 'project', scopeId: 'P1' })
    expect(byName.get('tdd')).toMatchObject({
      kind: 'skill',
      trigger: 'model',
      body: 'Skill body.'
    })
    expect(byName.get('plug:brain')?.source).toMatchObject({
      type: 'plugin',
      marketplace: 'market',
      plugin: 'plug'
    })
    expect(byName.get('review')).toMatchObject({
      kind: 'command',
      trigger: 'manual',
      body: 'Review it.'
    })
    // Ids iguais mesmo depois de o arquivo mudar (depende só da fonte + caminho).
    write(join(home, '.claude/CLAUDE.md'), 'Changed.')
    const t = new Date(Date.now() + 5000)
    utimesSync(claude, t, t)
    const c = discoverInstructions(project, 'P1', cfg)
    expect(c.find((i) => i.name === claude)?.id).toBe(byName.get(claude)?.id)
    expect(c.find((i) => i.name === claude)?.body).toBe('Changed.')
  })
})

describe('system prompt pelo resolvedor', () => {
  const legacy = (p: Project, cfg: AppConfig, subagent = false): string =>
    buildSystemPrompt({
      projectRoot: p.path,
      shell: shellLabel(cfg.shell),
      date: new Date().toISOString().slice(0, 10),
      instructions: loadInstructions(p.path, cfg.instructionFiles ?? []).text,
      skills: discoverSkills(p.path, cfg.skillRoots ?? [], cfg.pluginRoots ?? []),
      subagents: subagent ? [] : discoverAgents(p.path, cfg.agentRoots ?? [])
    })

  it('sem instruções novas: idêntico à montagem anterior (disco e banco vazio)', () => {
    const { home, project, cfg, db } = env
    write(join(home, '.claude/CLAUDE.md'), 'Always answer in Portuguese.\n@shared.md')
    write(join(home, '.claude/shared.md'), 'Shared piece.')
    write(join(home, '.codex/AGENTS.md'), '@../.claude/shared.md\nCodex rules.')
    write(join(project, 'AGENTS.md'), 'Run npm test.')
    write(join(project, 'CLAUDE.md'), 'Project claude.')
    skill(join(home, '.claude/skills'), 'tdd', 'name: tdd\ndescription: write tests\n  first')
    skill(join(project, '.claude/skills'), 'tdd', 'name: tdd\ndescription: project tdd')
    skill(join(home, '.claude/skills'), 'alpha', 'name: alpha\ndescription: a')
    skill(join(home, '.claude/plugins/cache/m/plug/1.0.0/skills'), 'x', 'name: x\ndescription: px')
    write(join(home, '.claude/commands/tdd.md'), 'A command with the same name as a skill.')
    write(join(home, '.claude/agents/rev.md'), '---\nname: rev\ndescription: reviewer\n---\nR')
    const p: Project = { id: 'p', path: project, name: 'proj', createdAt: 0, lastOpenedAt: null }

    expect(systemFor(p, cfg)).toBe(legacy(p, cfg))
    expect(systemFor(p, cfg, { subagent: true })).toBe(legacy(p, cfg, true))

    const resolver = createInstructionResolver({
      repo: new InstructionRepo(db),
      touched: new TouchedPathRepo(db)
    })
    const withRepo = systemFor(p, cfg, {}, { resolver, chat: { id: 'c1', groupId: null } })
    expect(withRepo).toBe(legacy(p, cfg))
  })

  it('config de teste com raízes vazias: prompt sem seções de instruções/skills', () => {
    const { project } = env
    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      instructionFiles: [],
      skillRoots: [],
      commandRoots: [],
      agentRoots: [],
      pluginRoots: [],
      ruleRoots: []
    }
    const p: Project = { id: 'p', path: project, name: 'proj', createdAt: 0, lastOpenedAt: null }
    const sys = systemFor(p, cfg)
    expect(sys).toBe(legacy(p, cfg))
    expect(sys).not.toContain('# User instructions')
    expect(sys).not.toContain('# Skills')
  })

  it('regra do app entra no bloco de instruções; seções extras vão no fim', () => {
    const { project, cfg, db } = env
    const repo = new InstructionRepo(db)
    const projects = new ProjectRepo(db)
    const proj = projects.create(project, 'proj')
    repo.create({
      kind: 'rule',
      scope: 'project',
      scopeId: proj.id,
      name: 'lang',
      trigger: 'always',
      body: 'Reply in pt-BR.'
    })
    const resolver = createInstructionResolver({ repo })
    const off = resolver.registerSection(() => '# Memory\n- [m1] algo')
    const sys = systemFor(proj, cfg, {}, { resolver })
    expect(sys).toContain('Instruction "lang" (rule, project scope):\n\nReply in pt-BR.')
    expect(sys.indexOf('Reply in pt-BR.')).toBeLessThan(sys.indexOf('# Rules'))
    expect(sys.endsWith('# Memory\n- [m1] algo')).toBe(true)
    off()
    expect(systemFor(proj, cfg, {}, { resolver })).not.toContain('# Memory')
  })
})

describe('serviço do resolvedor', () => {
  it('glob só entra depois de o chat tocar um arquivo que casa', () => {
    const { project, cfg, db } = env
    const repo = new InstructionRepo(db)
    const touched = new TouchedPathRepo(db)
    const projects = new ProjectRepo(db)
    const proj = projects.create(project, 'proj')
    const chat = new ChatRepo(db).create({
      projectId: proj.id,
      title: 't',
      color: '#fff',
      combo: 'x',
      permissionMode: 'allow-all'
    })
    repo.create({
      kind: 'rule',
      scope: 'global',
      name: 'ts-style',
      trigger: 'glob',
      globs: ['src/**/*.ts'],
      body: 'Use strict TS.'
    })
    const resolver = createInstructionResolver({ repo, touched })
    const ictx = {
      projectRoot: project,
      projectId: proj.id,
      groupId: null,
      chatId: chat.id,
      cfg
    }
    expect(resolver.resolve(ictx).always).toEqual([])
    resolver.recordTouched(chat.id, 'README.md')
    expect(resolver.resolve(ictx).always).toEqual([])
    resolver.recordTouched(chat.id, 'src\\core\\a.ts')
    const r = resolver.resolve(ictx)
    expect(r.always.map((i) => i.name)).toEqual(['ts-style'])
    expect(r.active.items[0].reason).toContain('src/core/a.ts')
    expect(resolver.lastActive(chat.id)?.items).toHaveLength(1)
  })

  it('manual por @nome: bloco antes do texto; sem citação, texto intacto', () => {
    const { project, cfg, db } = env
    const repo = new InstructionRepo(db)
    repo.create({
      kind: 'command',
      scope: 'global',
      name: 'checklist',
      trigger: 'manual',
      body: 'Run lint and tests.'
    })
    const resolver = createInstructionResolver({ repo })
    const ictx = { projectRoot: project, projectId: null, groupId: null, chatId: 'c', cfg }
    expect(resolver.expandManual(ictx, 'faça @checklist agora')).toEqual({
      text: '<instruction name="checklist" kind="command">\nRun lint and tests.\n</instruction>\n\nfaça @checklist agora',
      names: ['checklist']
    })
    expect(resolver.expandManual(ictx, 'sem nada')).toEqual({ text: 'sem nada', names: [] })
    expect(resolver.expandManual(ictx, '/checklist').names).toEqual(['checklist'])
  })

  it('provedor dinâmico entra como candidato (ex.: instruções de memória/regra)', () => {
    const { project, cfg } = env
    const resolver = createInstructionResolver()
    resolver.registerProvider((c) => [
      inst({ id: 'dyn', name: 'dyn', scope: 'chat', scopeId: c.chatId, body: 'Dynamic.' })
    ])
    const r = resolver.resolve({
      projectRoot: project,
      projectId: null,
      groupId: null,
      chatId: 'c',
      cfg
    })
    expect(r.always.map((i) => i.body)).toEqual(['Dynamic.'])
  })
})

describe('handlers instructions.*', () => {
  function handlers(): {
    h: Record<string, (p: unknown) => unknown>
    repo: InstructionRepo
    projectId: string
    chatId: string
  } {
    const { project, cfg, db } = env
    const repo = new InstructionRepo(db)
    const projects = new ProjectRepo(db)
    const chats = new ChatRepo(db)
    const proj = projects.create(project, 'proj')
    const chat = chats.create({
      projectId: proj.id,
      title: 't',
      color: '#fff',
      combo: 'x',
      permissionMode: 'allow-all'
    })
    const resolver = createInstructionResolver({ repo, touched: new TouchedPathRepo(db) })
    const mod = instructionHandlers({ resolver, repo, projects, chats, getConfig: () => cfg })
    const h = mod({ db, blobs: new BlobStore(join(env.base, 'blobs')), emit: () => {} }) as Record<
      string,
      (p: unknown) => unknown
    >
    return { h, repo, projectId: proj.id, chatId: chat.id }
  }

  it('toggle desliga skill de plugin (some do prompt e da ferramenta)', () => {
    const { home, project, cfg } = env
    skill(
      join(home, '.claude/plugins/cache/m/plug/1.0.0/skills'),
      'brain',
      'name: brain\ndescription: plugin skill'
    )
    const { h, projectId, chatId } = handlers()
    const list = h['instructions.list']({ projectId, kind: 'skill' }) as Instruction[]
    const brain = list.find((i) => i.name === 'plug:brain')!
    expect(brain.enabled).toBe(true)
    const p: Project = {
      id: projectId,
      path: project,
      name: 'proj',
      createdAt: 0,
      lastOpenedAt: null
    }
    expect(systemFor(p, cfg)).toContain('- plug:brain: plugin skill')

    const off = h['instructions.setEnabled']({ id: brain.id, enabled: false }) as Instruction
    expect(off.enabled).toBe(false)
    const again = h['instructions.list']({ chatId, kind: 'skill' }) as Instruction[]
    expect(again.find((i) => i.id === brain.id)?.enabled).toBe(false)
    const active = h['instructions.active']({ chatId }) as { items: { name: string }[] }
    expect(active.items.map((i) => i.name)).not.toContain('plug:brain')
    // Excluir/editar descoberto: READONLY.
    expect(() => h['instructions.delete']({ id: brain.id })).toThrow(
      expect.objectContaining({ code: 'READONLY' })
    )
    expect(() =>
      h['instructions.save']({
        id: brain.id,
        kind: 'skill',
        scope: 'global',
        name: 'x',
        trigger: 'model',
        body: ''
      })
    ).toThrow(expect.objectContaining({ code: 'READONLY' }))
    expect(h['instructions.setEnabled']({ id: brain.id, enabled: true })).toMatchObject({
      enabled: true
    })
  })

  it('save cria/atualiza itens do app; source não-app é READONLY; delete e active', () => {
    const { h, repo, projectId, chatId } = handlers()
    const created = h['instructions.save']({
      kind: 'rule',
      scope: 'chat',
      scopeId: chatId,
      name: ' curto ',
      trigger: 'always',
      body: 'Seja breve.'
    }) as Instruction
    expect(created).toMatchObject({ name: 'curto', source: { type: 'app' }, readonly: false })
    const updated = h['instructions.save']({
      id: created.id,
      kind: 'rule',
      scope: 'chat',
      scopeId: chatId,
      name: 'curto',
      trigger: 'always',
      body: 'Seja muito breve.'
    }) as Instruction
    expect(updated.body).toBe('Seja muito breve.')
    expect(() =>
      h['instructions.save']({
        kind: 'rule',
        scope: 'global',
        name: 'x',
        trigger: 'always',
        body: 'b',
        source: { type: 'file', path: '/x' }
      })
    ).toThrow(expect.objectContaining({ code: 'READONLY' }))
    expect(() =>
      h['instructions.save']({
        kind: 'rule',
        scope: 'chat',
        name: 'x',
        trigger: 'always',
        body: 'b'
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))

    const active = h['instructions.active']({ chatId }) as {
      chatId: string
      items: { name: string; included: string }[]
    }
    expect(active.chatId).toBe(chatId)
    expect(active.items).toEqual([expect.objectContaining({ name: 'curto', included: 'content' })])
    expect((h['instructions.list']({ projectId }) as Instruction[]).map((i) => i.name)).toEqual([])
    expect(h['instructions.delete']({ id: created.id })).toBeNull()
    expect(repo.get(created.id)).toBeNull()
    expect(() => h['instructions.delete']({ id: 'nope' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })
})

describe('engine: caminhos tocados e @nome', () => {
  it('read_file registra o caminho e ativa a regra glob no próximo request; @nome vira bloco', async () => {
    const { base, project } = env
    write(join(project, 'src/a.ts'), 'export const a = 1\n')
    const router = await startFakeRouter([
      {
        chunks: [
          chunk.toolCall(0, 'c1', 'read_file', '{"path":"src/a.ts"}'),
          chunk.finish('tool_calls')
        ]
      },
      { chunks: [chunk.text('ok'), chunk.finish('stop'), chunk.usage(10, 2)] }
    ])
    routers.push(router)
    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      routerBaseUrl: router.url,
      routerApiKey: 'sk-test',
      defaultCombo: 'fake/combo',
      routerDbPath: join(base, 'no-router.sqlite'),
      instructionFiles: [],
      skillRoots: [],
      commandRoots: [],
      agentRoots: [],
      pluginRoots: [],
      ruleRoots: []
    }
    const events: EngineEvent[] = []
    const s = createServices(
      { db: env.db, blobs: new BlobStore(join(base, 'blobs')), emit: (e) => events.push(e) },
      { model: createOpenAiClient(() => cfg), getConfig: () => cfg, retryDelaysMs: [10] }
    )
    const proj = s.projects.create(project, 'proj')
    const chat = s.chats.create({
      projectId: proj.id,
      title: 't',
      color: '#fff',
      combo: 'fake/combo',
      permissionMode: 'allow-all'
    })
    s.instructionRepo.create({
      kind: 'rule',
      scope: 'project',
      scopeId: proj.id,
      name: 'ts',
      trigger: 'glob',
      globs: ['**/*.ts'],
      body: 'TS_RULE_BODY'
    })
    s.instructionRepo.create({
      kind: 'command',
      scope: 'global',
      name: 'plan',
      trigger: 'manual',
      body: 'PLAN_BODY'
    })
    await s.engine.send(chat.id, 'leia @plan', [])
    const end = Date.now() + 15_000
    while (!events.some((e) => e.type === 'turn_finished' || e.type === 'turn_error')) {
      if (Date.now() > end) throw new Error('turno não terminou')
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(events.find((e) => e.type === 'turn_error')).toBeUndefined()
    expect(s.touchedPaths.list(chat.id)).toEqual(['src/a.ts'])
    const [first, second] = router.requests
    expect(first.messages[0].content).not.toContain('TS_RULE_BODY')
    expect(second.messages[0].content).toContain('TS_RULE_BODY')
    const user = first.messages.find((m: { role: string }) => m.role === 'user')
    expect(user.content).toContain('PLAN_BODY')
    expect(user.content.indexOf('PLAN_BODY')).toBeLessThan(user.content.indexOf('leia @plan'))
    const active = s.instructions.lastActive(chat.id)
    expect(active?.items.map((i) => i.name).sort()).toEqual(['plan', 'ts'])
  })
})
