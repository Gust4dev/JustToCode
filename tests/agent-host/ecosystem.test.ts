import { beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig, type Project } from '../../src/shared/domain'
import { expandHome } from '../../src/agent-host/ecosystem/paths'
import { parseFrontmatter } from '../../src/agent-host/ecosystem/frontmatter'
import { loadInstructions } from '../../src/agent-host/ecosystem/instructions'
import { discoverSkills } from '../../src/agent-host/ecosystem/skills'
import {
  applyArguments,
  expandCommand,
  listCommands
} from '../../src/agent-host/ecosystem/commands'
import { createSkillTool } from '../../src/agent-host/tools/skill'
import type { ToolContext } from '../../src/agent-host/tools/types'
import { systemFor } from '../../src/agent-host/engine/turn'
import { MAX_INSTRUCTIONS_CHARS, buildSystemPrompt } from '../../src/agent-host/engine/systemPrompt'
import { openDb } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { ProjectRepo } from '../../src/agent-host/repo/projects'
import { ecosystemHandlers } from '../../src/agent-host/handlers/ecosystem'

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

interface Env {
  base: string
  home: string
  project: string
  cfg: AppConfig
}

/** Pastas temporárias: "home" falsa para as raízes globais e um projeto. Nunca usa o ~ real. */
function setup(): Env {
  const base = mkdtempSync(join(tmpdir(), 'jtc-eco-'))
  const home = join(base, 'home')
  const project = join(base, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    instructionFiles: [join(home, '.claude/CLAUDE.md'), join(home, '.codex/AGENTS.md')],
    skillRoots: [join(home, '.claude/skills'), join(home, '.agents/skills')],
    commandRoots: [join(home, '.claude/commands')],
    agentRoots: [join(home, '.claude/agents')],
    pluginRoots: [join(home, '.claude/plugins/cache')]
  }
  return { base, home, project, cfg }
}

let env: Env
beforeEach(() => {
  env = setup()
})

describe('paths', () => {
  it('expandHome troca ~ pelo homedir', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/x/y.md')).toBe(join(homedir(), 'x/y.md'))
    expect(expandHome('/abs/~x')).toBe('/abs/~x')
  })
})

describe('frontmatter', () => {
  it('lê chave: valor, lista inline e lista com hífen', () => {
    const md = [
      '---',
      'name: my-skill',
      'description: "Does things: well"',
      'tools: [read_file, grep, "shell"]',
      'other:',
      '  - a',
      '  - b',
      'count: 3',
      '---',
      '',
      '# Body',
      'text'
    ].join('\n')
    const { data, body } = parseFrontmatter(md)
    expect(data.name).toBe('my-skill')
    expect(data.description).toBe('Does things: well')
    expect(data.tools).toEqual(['read_file', 'grep', 'shell'])
    expect(data.other).toEqual(['a', 'b'])
    expect(data.count).toBe(3)
    expect(body).toBe('# Body\ntext')
  })

  it('bloco | e >, CRLF, e texto sem frontmatter', () => {
    const md =
      '---\r\ndescription: >\r\n  line one\r\n  line two\r\nnotes: |\r\n  a\r\n  b\r\n---\r\nbody'
    const { data, body } = parseFrontmatter(md)
    expect(data.description).toBe('line one line two')
    expect(data.notes).toBe('a\nb')
    expect(body).toBe('body')
    expect(parseFrontmatter('# no fm\nx')).toEqual({ data: {}, body: '# no fm\nx' })
    expect(parseFrontmatter('---\nname: x\nno end')).toEqual({
      data: {},
      body: '---\nname: x\nno end'
    })
  })
})

describe('instruções', () => {
  it('ordem global → projeto e imports @ aninhados (relativo e absoluto)', () => {
    const { home, project, cfg } = env
    write(join(home, '.claude/CLAUDE.md'), 'global rules\n@rules/a.md\nend global')
    write(join(home, '.claude/rules/a.md'), 'A start\n@../b.md\nA end')
    write(join(home, '.claude/b.md'), `B text\n@${join(home, 'c.md')}`)
    write(join(home, 'c.md'), 'C text')
    write(join(project, 'AGENTS.md'), 'project agents')
    write(join(project, 'CLAUDE.md'), 'project claude')

    const r = loadInstructions(project, cfg.instructionFiles)
    const t = r.text
    expect(t.indexOf('global rules')).toBeLessThan(t.indexOf('A start'))
    expect(t.indexOf('A start')).toBeLessThan(t.indexOf('B text'))
    expect(t.indexOf('B text')).toBeLessThan(t.indexOf('C text'))
    expect(t.indexOf('C text')).toBeLessThan(t.indexOf('A end'))
    expect(t.indexOf('A end')).toBeLessThan(t.indexOf('end global'))
    expect(t.indexOf('end global')).toBeLessThan(t.indexOf('project agents'))
    expect(t.indexOf('project agents')).toBeLessThan(t.indexOf('project claude'))
    expect(t).not.toContain('@rules/a.md')
    expect(r.files.map((f) => [f.path, f.scope])).toEqual([
      [join(home, '.claude/CLAUDE.md'), 'global'],
      [join(home, '.claude/rules/a.md'), 'global'],
      [join(home, '.claude/b.md'), 'global'],
      [join(home, 'c.md'), 'global'],
      [join(project, 'AGENTS.md'), 'project'],
      [join(project, 'CLAUDE.md'), 'project']
    ])
    expect(r.files[0].bytes).toBeGreaterThan(0)
  })

  it('ciclo e repetidos entram uma vez só', () => {
    const { home, project, cfg } = env
    // CLAUDE.md importa o AGENTS.md global, que também está na lista da config.
    write(join(home, '.claude/CLAUDE.md'), `claude\n@${join(home, '.codex/AGENTS.md')}`)
    write(join(home, '.codex/AGENTS.md'), 'agents\n@x.md')
    write(join(home, '.codex/x.md'), `x\n@${join(home, '.codex/AGENTS.md')}\n@x.md`)
    const r = loadInstructions(project, cfg.instructionFiles)
    expect(r.text.match(/agents/g)).toHaveLength(1)
    expect(r.text.match(/^x$/gm)).toHaveLength(1)
    expect(r.files).toHaveLength(3)
  })

  it('ausentes são ignorados sem erro', () => {
    const { home, project, cfg } = env
    expect(loadInstructions(project, cfg.instructionFiles)).toEqual({ files: [], text: '' })
    write(join(home, '.claude/CLAUDE.md'), 'hello\n@missing.md')
    const r = loadInstructions(project, cfg.instructionFiles)
    expect(r.files).toHaveLength(1)
    expect(r.text).toContain('hello')
    expect(r.text).toContain('@missing.md')
  })

  it('para no 5º nível de import', () => {
    const { home, project } = env
    for (let i = 0; i < 8; i++) write(join(home, `l${i}.md`), `level${i}\n@l${i + 1}.md`)
    const r = loadInstructions(project, [join(home, 'l0.md')])
    expect(r.text).toContain('level5')
    expect(r.text).not.toContain('level6')
    expect(r.text).toContain('@l6.md')
  })

  it('cache invalida quando o mtime muda', () => {
    const { home, project, cfg } = env
    const f = write(join(home, '.claude/CLAUDE.md'), 'v1')
    expect(loadInstructions(project, cfg.instructionFiles).text).toContain('v1')
    writeFileSync(f, 'v2')
    const later = new Date(Date.now() + 5000)
    utimesSync(f, later, later)
    expect(loadInstructions(project, cfg.instructionFiles).text).toContain('v2')
    // arquivo do projeto que passa a existir também invalida
    write(join(project, 'AGENTS.md'), 'new project file')
    expect(loadInstructions(project, cfg.instructionFiles).text).toContain('new project file')
  })
})

function skill(root: string, folder: string, fm: string, body = 'Skill body.'): string {
  return write(join(root, folder, 'SKILL.md'), `---\n${fm}\n---\n${body}\n`)
}

describe('skills', () => {
  it('descobre nas várias raízes; projeto vence global no mesmo nome', () => {
    const { home, project, cfg } = env
    skill(join(home, '.claude/skills'), 'alpha', 'name: alpha\ndescription: global alpha')
    skill(join(home, '.agents/skills'), 'beta-folder', 'description: beta from folder')
    skill(join(home, '.claude/skills'), 'shared', 'name: shared\ndescription: global shared')
    skill(join(project, '.claude/skills'), 'shared', 'name: shared\ndescription: project shared')
    skill(join(project, '.agents/skills'), 'gamma', 'name: gamma\ndescription: project gamma')
    mkdirSync(join(home, '.claude/skills/empty'), { recursive: true })

    const s = discoverSkills(project, cfg.skillRoots)
    expect(s.map((x) => [x.name, x.description, x.scope])).toEqual([
      ['alpha', 'global alpha', 'global'],
      ['beta-folder', 'beta from folder', 'global'],
      ['gamma', 'project gamma', 'project'],
      ['shared', 'project shared', 'project']
    ])
  })

  it('ferramenta skill devolve o corpo sem frontmatter e a pasta', async () => {
    const { home, project, cfg } = env
    const path = skill(
      join(home, '.claude/skills'),
      'deploy',
      'name: deploy\ndescription: d',
      'Step 1\nStep 2'
    )
    const tool = createSkillTool(() => cfg)
    expect(tool.kind).toBe('read')
    const ctx = { projectRoot: project } as ToolContext
    const r = await tool.run({ name: 'deploy' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('Step 1\nStep 2')
    expect(r.content).toContain(dirname(path))
    expect(r.content).not.toContain('description:')
    const miss = await tool.run({ name: 'nope' }, ctx)
    expect(miss.isError).toBe(true)
    expect(miss.content).toContain('deploy')
  })
})

describe('slash commands', () => {
  it('lista comandos globais, do projeto e skills', () => {
    const { home, project, cfg } = env
    write(
      join(home, '.claude/commands/review.md'),
      '# Review the code\nReview $ARGUMENTS carefully.'
    )
    write(join(home, '.claude/commands/fix.md'), '---\ndescription: global fix\n---\nFix it.')
    write(
      join(project, '.claude/commands/fix.md'),
      '---\ndescription: project fix\n---\nFix $ARGUMENTS now.'
    )
    skill(join(home, '.claude/skills'), 'tdd', 'name: tdd\ndescription: test first')

    const c = listCommands(project, cfg)
    expect(c.map((x) => [x.name, x.description, x.source, x.scope])).toEqual([
      ['fix', 'project fix', 'command', 'project'],
      ['review', 'Review the code', 'command', 'global'],
      ['tdd', 'test first', 'skill', 'global']
    ])
  })

  it('expansão com e sem $ARGUMENTS, e de skill', () => {
    const { home, project, cfg } = env
    write(
      join(home, '.claude/commands/review.md'),
      '---\ndescription: r\n---\nReview $ARGUMENTS carefully. ($ARGUMENTS)'
    )
    write(join(home, '.claude/commands/plain.md'), 'Plain command.')
    skill(join(home, '.claude/skills'), 'tdd', 'name: tdd\ndescription: test first')

    expect(expandCommand(project, cfg, 'review', 'src/a.ts')).toBe(
      'Review src/a.ts carefully. (src/a.ts)'
    )
    expect(expandCommand(project, cfg, '/plain', 'extra words')).toBe(
      'Plain command.\n\nextra words'
    )
    expect(expandCommand(project, cfg, 'plain', '')).toBe('Plain command.')
    expect(expandCommand(project, cfg, 'tdd', 'the parser')).toBe('Use the skill "tdd". the parser')
    expect(expandCommand(project, cfg, 'tdd', '')).toBe('Use the skill "tdd".')
    expect(expandCommand(project, cfg, 'missing', '')).toBeNull()
    expect(applyArguments('a $ARGUMENTS b', '$&')).toBe('a $& b')
  })
})

describe('system prompt', () => {
  it('contém instruções (antes de # Rules) e skills', () => {
    const { home, project, cfg } = env
    write(join(home, '.claude/CLAUDE.md'), 'Always answer in Portuguese.')
    write(join(project, 'AGENTS.md'), 'Run npm test before finishing.')
    skill(join(home, '.claude/skills'), 'tdd', 'name: tdd\ndescription: write tests first')
    const p: Project = { id: 'p', path: project, name: 'proj', createdAt: 0, lastOpenedAt: null }
    const sys = systemFor(p, cfg)
    expect(sys).toContain('# User instructions')
    expect(sys).toContain('Always answer in Portuguese.')
    expect(sys).toContain('Run npm test before finishing.')
    expect(sys.indexOf('# User instructions')).toBeLessThan(sys.indexOf('# Rules'))
    expect(sys).toContain('# Skills')
    expect(sys).toContain('- tdd: write tests first')
    expect(sys).toContain('Use the skill tool to load one before following it')
  })

  it('sem instruções nem skills não cria as seções; corta acima do limite com aviso', () => {
    const base = { projectRoot: '/p', shell: 'pwsh', date: '2026-01-01' }
    const plain = buildSystemPrompt(base)
    expect(plain).not.toContain('# User instructions')
    expect(plain).not.toContain('# Skills')
    const big = buildSystemPrompt({
      ...base,
      instructions: 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 10)
    })
    expect(big).toContain('x'.repeat(MAX_INSTRUCTIONS_CHARS))
    expect(big).not.toContain('x'.repeat(MAX_INSTRUCTIONS_CHARS + 1))
    expect(big).toContain('Instructions truncated')
  })
})

describe('handlers ecosystem.*', () => {
  it('instructions, skills, commands e expandCommand', async () => {
    const { base, home, project, cfg } = env
    write(join(project, 'AGENTS.md'), 'proj')
    write(join(home, '.claude/commands/hi.md'), 'Hello $ARGUMENTS')
    skill(join(project, '.claude/skills'), 'loc', 'name: loc\ndescription: local')
    const db = openDb(join(base, 'db.sqlite'))
    const ctx = { db, blobs: new BlobStore(join(base, 'blobs')), emit: () => {} }
    const proj = new ProjectRepo(db).create(project, 'proj')
    const h = ecosystemHandlers(() => cfg)(ctx)

    const files = (await h['ecosystem.instructions']({ projectId: proj.id })) as { path: string }[]
    expect(files.map((f) => f.path)).toEqual([join(project, 'AGENTS.md')])
    const skills = (await h['ecosystem.skills']({ projectId: proj.id })) as { name: string }[]
    expect(skills.map((s) => s.name)).toEqual(['loc'])
    const cmds = (await h['ecosystem.commands']({ projectId: proj.id })) as { name: string }[]
    expect(cmds.map((c) => c.name)).toEqual(['hi', 'loc'])
    expect(
      await h['ecosystem.expandCommand']({ projectId: proj.id, name: 'hi', args: 'world' })
    ).toEqual({ text: 'Hello world' })
    expect(() =>
      h['ecosystem.expandCommand']({ projectId: proj.id, name: 'nope', args: '' })
    ).toThrow(/nope/)
    expect(() => h['ecosystem.skills']({ projectId: 'missing' })).toThrow()
    db.close()
  })
})

describe('skills aninhadas e plugins', () => {
  it('descobre SKILL.md recursivamente até 4 níveis, ignorando node_modules e .git', () => {
    const { home, project, cfg } = env
    const root = join(home, '.claude/skills')
    skill(join(root, 'learned'), 'nested-a', 'description: nested a')
    skill(join(root, 'synced/team'), 'nested-b', 'name: bee\ndescription: nested b')
    skill(join(root, 'a/b/c'), 'depth4', 'description: at depth 4')
    skill(join(root, 'a/b/c/d'), 'depth5', 'description: too deep')
    skill(join(root, 'node_modules'), 'nm', 'description: ignored')
    skill(join(root, '.git'), 'gitskill', 'description: ignored')
    // Dentro de uma skill não se procura outra.
    skill(join(root, 'outer'), '', 'name: outer\ndescription: outer')
    skill(join(root, 'outer'), 'inner', 'name: inner\ndescription: inner')
    const names = discoverSkills(project, cfg.skillRoots, cfg.pluginRoots).map((s) => s.name)
    expect(names).toEqual(['bee', 'depth4', 'nested-a', 'outer'])
  })

  it('não segue symlink/junction para fora da raiz', () => {
    const { base, home, project, cfg } = env
    const root = join(home, '.claude/skills')
    skill(root, 'inside', 'description: in')
    skill(join(base, 'outside'), 'evil', 'description: out')
    try {
      symlinkSync(join(base, 'outside'), join(root, 'link'), 'junction')
    } catch {
      return // sem permissão para criar links neste ambiente
    }
    const names = discoverSkills(project, cfg.skillRoots, cfg.pluginRoots).map((s) => s.name)
    expect(names).toEqual(['inside'])
  })

  it('plugins: só a versão mais recente, nomes <plugin>:<nome> para skills e commands', () => {
    const { home, project, cfg } = env
    const pdir = join(home, '.claude/plugins/cache/market/superp')
    skill(join(pdir, '1.0.0/skills'), 'brainstorming', 'name: brainstorming\ndescription: old')
    skill(join(pdir, '2.0.0/skills'), 'brainstorming', 'name: brainstorming\ndescription: new')
    skill(join(pdir, '2.0.0/skills/group'), 'tdd', 'description: nested in plugin')
    write(join(pdir, '1.0.0/commands/old.md'), 'Old command')
    write(
      join(pdir, '2.0.0/commands/plan.md'),
      '---\ndescription: make a plan\n---\nPlan $ARGUMENTS'
    )
    const old = new Date(Date.now() - 60_000)
    const fresh = new Date(Date.now() + 60_000)
    utimesSync(join(pdir, '1.0.0'), old, old)
    utimesSync(join(pdir, '2.0.0'), fresh, fresh)

    const skills = discoverSkills(project, cfg.skillRoots, cfg.pluginRoots)
    expect(skills.map((s) => [s.name, s.description])).toEqual([
      ['superp:brainstorming', 'new'],
      ['superp:tdd', 'nested in plugin']
    ])
    const cmds = listCommands(project, cfg)
    expect(cmds.map((c) => [c.name, c.source])).toEqual([
      ['superp:brainstorming', 'skill'],
      ['superp:plan', 'command'],
      ['superp:tdd', 'skill']
    ])
    expect(expandCommand(project, cfg, '/superp:plan', 'x')).toBe('Plan x')
    expect(expandCommand(project, cfg, 'superp:tdd', '')).toBe('Use the skill "superp:tdd".')
  })

  it('ferramenta skill acha skill de plugin', async () => {
    const { home, project, cfg } = env
    skill(
      join(home, '.claude/plugins/cache/m/plug/0.1.0/skills'),
      'x',
      'name: x\ndescription: d',
      'Plugin body'
    )
    const r = await createSkillTool(() => cfg).run({ name: 'plug:x' }, {
      projectRoot: project
    } as ToolContext)
    expect(r.content).toContain('Plugin body')
  })

  it('300 skills: descoberta abaixo de ~300 ms', () => {
    const { home, project, cfg } = env
    for (let i = 0; i < 300; i++) {
      const group = i % 3 === 0 ? 'learned' : i % 3 === 1 ? 'synced/x' : ''
      const root =
        i % 2 === 0
          ? join(home, '.claude/skills', group)
          : join(home, `.claude/plugins/cache/m/p${i % 10}/1.0.0/skills`, group)
      skill(root, `s${i}`, `name: s${i}\ndescription: skill ${i}`)
    }
    const t0 = performance.now()
    const cold = discoverSkills(project, cfg.skillRoots, cfg.pluginRoots)
    const coldMs = performance.now() - t0
    const t1 = performance.now()
    const warm = discoverSkills(project, cfg.skillRoots, cfg.pluginRoots)
    const warmMs = performance.now() - t1
    expect(cold).toHaveLength(300)
    expect(warm).toBe(cold)
    expect(coldMs).toBeLessThan(300)
    expect(warmMs).toBeLessThan(300)
  })
})
