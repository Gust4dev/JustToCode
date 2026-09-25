import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig } from '../../src/shared/domain'
import { openDb, type Db } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import { ProjectRepo } from '../../src/agent-host/repo/projects'
import { ChatRepo } from '../../src/agent-host/repo/chats'
import { InstructionRepo } from '../../src/agent-host/repo/instructions'
import { TouchedPathRepo } from '../../src/agent-host/repo/touchedPaths'
import {
  formatOf,
  parseInstructionText,
  serializeInstruction
} from '../../src/agent-host/ecosystem/frontmatter'
import {
  discoverInstructions,
  stableInstructionId
} from '../../src/agent-host/ecosystem/instructionSources'
import { expandCommand, listFileCommands } from '../../src/agent-host/ecosystem/commands'
import { createInstructionResolver } from '../../src/agent-host/ecosystem/resolver'
import { exportFileName, instructionHandlers } from '../../src/agent-host/handlers/instructions'

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

let base: string
let home: string
let project: string
let cfg: AppConfig
const dbs: Db[] = []

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'jtc-formats-'))
  home = join(base, 'home')
  project = join(base, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  cfg = {
    ...DEFAULT_CONFIG,
    instructionFiles: [],
    skillRoots: [join(home, '.claude/skills')],
    commandRoots: [join(home, '.claude/commands')],
    agentRoots: [],
    pluginRoots: [],
    ruleRoots: [join(home, '.claude/rules')]
  }
})

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  rmSync(base, { recursive: true, force: true })
})

describe('frontmatter .md com campos de instrução', () => {
  it('lê trigger, globs (lista), command e scope', () => {
    const f = parseInstructionText(
      [
        '---',
        'name: react-rules',
        'description: regras de React',
        'trigger: glob',
        'globs:',
        '  - "src/**/*.tsx"',
        '  - "*.{ts,tsx}"',
        'command: /react',
        'scope: project',
        '---',
        'Use hooks.'
      ].join('\n'),
      'md'
    )
    expect(f.format).toBe('md')
    expect(f.body.trim()).toBe('Use hooks.')
    expect(f.meta).toEqual({
      name: 'react-rules',
      description: 'regras de React',
      trigger: 'glob',
      globs: ['src/**/*.tsx', '*.{ts,tsx}'],
      command: 'react',
      scope: 'project'
    })
  })

  it('globs como texto separado por vírgula e `paths` como alias; valores inválidos ignorados', () => {
    const a = parseInstructionText('---\nglobs: "*.ts, *.tsx"\ntrigger: sempre\n---\nx', 'md')
    expect(a.meta.globs).toEqual(['*.ts', '*.tsx'])
    expect(a.meta.trigger).toBeUndefined()
    const b = parseInstructionText('---\npaths: [src/**, docs/**]\nscope: universo\n---\nx', 'md')
    expect(b.meta.globs).toEqual(['src/**', 'docs/**'])
    expect(b.meta.scope).toBeUndefined()
  })

  it('sem frontmatter: meta vazio e corpo inteiro', () => {
    const f = parseInstructionText('Só texto.', 'md')
    expect(f.meta).toEqual({})
    expect(f.body).toBe('Só texto.')
  })
})

describe('.toml', () => {
  it('comando do Gemini CLI: prompt + description', () => {
    const f = parseInstructionText(
      'description = "Revisa o diff"\nprompt = """\nRevise o diff: {{args}}\n"""\n',
      'toml'
    )
    expect(f.format).toBe('toml')
    expect(f.meta).toEqual({ description: 'Revisa o diff' })
    expect(f.body.trim()).toBe('Revise o diff: {{args}}')
  })

  it('nativo: mesmos campos + body', () => {
    const f = parseInstructionText(
      [
        'name = "api"',
        'description = "Regras da API"',
        'trigger = "glob"',
        'globs = ["api/**/*.ts"]',
        'command = "api"',
        'scope = "global"',
        "body = '''",
        'Valide entradas.',
        "'''"
      ].join('\n'),
      'toml'
    )
    expect(f.meta).toEqual({
      name: 'api',
      description: 'Regras da API',
      trigger: 'glob',
      globs: ['api/**/*.ts'],
      command: 'api',
      scope: 'global'
    })
    expect(f.body.trim()).toBe('Valide entradas.')
  })

  it('TOML inválido → sem dados e corpo vazio', () => {
    const f = parseInstructionText('prompt = "sem fim', 'toml')
    expect(f).toMatchObject({ data: {}, body: '', meta: {} })
  })

  it('TOML com BOM é lido normalmente', () => {
    expect(parseInstructionText(String.fromCharCode(0xfeff) + 'prompt = "Oi"\n', 'toml').body).toBe(
      'Oi'
    )
  })

  it('formatOf pela extensão', () => {
    expect(formatOf('a/b.TOML')).toBe('toml')
    expect(formatOf('a/b.md')).toBe('md')
  })
})

describe('descoberta com os novos formatos', () => {
  it('commands aceitam .toml (Gemini CLI) e expandem {{args}}', () => {
    write(
      join(home, '.claude/commands/review.toml'),
      'description = "Revisa"\nprompt = "Revise: {{args}}"\n'
    )
    write(join(project, '.claude/commands/ship.md'), '---\ncommand: deploy\n---\nDeploy $ARGUMENTS')
    const cmds = listFileCommands(project, cfg.commandRoots, [])
    expect(cmds.map((c) => [c.name, c.description, c.scope])).toEqual([
      ['review', 'Revisa', 'global'],
      ['deploy', 'Deploy $ARGUMENTS', 'project']
    ])
    const roots = { commandRoots: cfg.commandRoots, skillRoots: cfg.skillRoots }
    expect(expandCommand(project, roots, 'review', 'src/a.ts')).toBe('Revise: src/a.ts')
    expect(expandCommand(project, roots, 'deploy', 'prod')).toBe('Deploy prod')
  })

  it('regras de ~/.claude/rules/** e <projeto>/.claude/rules/** (md e toml)', () => {
    const g = write(join(home, '.claude/rules/style.md'), 'Global style.')
    const nested = write(
      join(home, '.claude/rules/web/react.md'),
      '---\ndescription: react\nglobs: ["src/**/*.tsx"]\n---\nUse hooks.'
    )
    const p = write(
      join(project, '.claude/rules/db.toml'),
      'name = "banco"\ntrigger = "manual"\nbody = "Use migrations."\n'
    )
    write(join(project, '.claude/rules/node_modules/x.md'), 'ignorar')
    write(join(project, '.claude/rules/notes.txt'), 'ignorar')

    const rules = discoverInstructions(project, 'p1', cfg).filter((i) => i.kind === 'rule')
    expect(
      rules.map((r) => ({
        id: r.id,
        name: r.name,
        scope: r.scope,
        scopeId: r.scopeId,
        trigger: r.trigger,
        globs: r.globs,
        format: r.format,
        body: r.body,
        readonly: r.readonly
      }))
    ).toEqual([
      {
        id: stableInstructionId('file', g),
        name: 'style',
        scope: 'global',
        scopeId: null,
        trigger: 'always',
        globs: [],
        format: 'md',
        body: 'Global style.',
        readonly: true
      },
      {
        id: stableInstructionId('file', nested),
        name: 'web/react',
        scope: 'global',
        scopeId: null,
        trigger: 'glob',
        globs: ['src/**/*.tsx'],
        format: 'md',
        body: 'Use hooks.',
        readonly: true
      },
      {
        id: stableInstructionId('file', p),
        name: 'banco',
        scope: 'project',
        scopeId: 'p1',
        trigger: 'manual',
        globs: [],
        format: 'toml',
        body: 'Use migrations.',
        readonly: true
      }
    ])
  })

  it('ruleRoots vazio: só as regras do projeto', () => {
    write(join(home, '.claude/rules/style.md'), 'Global style.')
    write(join(project, '.claude/rules/p.md'), 'Project rule.')
    const rules = discoverInstructions(project, 'p1', { ...cfg, ruleRoots: [] }).filter(
      (i) => i.kind === 'rule'
    )
    expect(rules.map((r) => r.name)).toEqual(['p'])
  })

  it('trigger/globs do frontmatter substituem o padrão de skills e commands', () => {
    write(
      join(home, '.claude/skills/lint/SKILL.md'),
      '---\nname: lint\ndescription: d\ntrigger: glob\nglobs: ["**/*.ts"]\n---\nLint it.'
    )
    write(join(home, '.claude/skills/plain/SKILL.md'), '---\nname: plain\ndescription: d\n---\nP')
    write(join(home, '.claude/commands/boot.toml'), 'trigger = "always"\nprompt = "Boot."\n')
    const all = discoverInstructions(project, 'p1', cfg)
    const by = (n: string): (typeof all)[number] | undefined => all.find((i) => i.name === n)
    expect(by('lint')).toMatchObject({ kind: 'skill', trigger: 'glob', globs: ['**/*.ts'] })
    expect(by('plain')).toMatchObject({ kind: 'skill', trigger: 'model', globs: [] })
    expect(by('boot')).toMatchObject({
      kind: 'command',
      trigger: 'always',
      format: 'toml',
      body: 'Boot.'
    })
  })
})

describe('serializeInstruction (ida e volta)', () => {
  const inst = {
    name: 'api:rules',
    description: 'Regras\nda API',
    trigger: 'glob' as const,
    globs: ['src/**/*.{ts,tsx}', 'api/*'],
    scope: 'project' as const,
    body: 'Linha 1\nLinha 2 com \'aspas\' e "duplas"\n'
  }
  for (const format of ['md', 'toml'] as const) {
    it(`${format}: lido de volta com os mesmos campos`, () => {
      const f = parseInstructionText(serializeInstruction(inst, format), format)
      expect(f.meta).toEqual({
        name: 'api:rules',
        description: 'Regras da API',
        trigger: 'glob',
        globs: ['src/**/*.{ts,tsx}', 'api/*'],
        scope: 'project'
      })
      expect(f.body.trim()).toBe(inst.body.trim())
    })
  }
  it("toml com ''' no corpo usa string básica escapada", () => {
    const text = serializeInstruction({ ...inst, body: "a '''b''' c" }, 'toml')
    expect(parseInstructionText(text, 'toml').body).toBe("a '''b''' c")
  })
})

describe('instructions.export', () => {
  function handlers(): {
    h: Record<string, (p: unknown) => unknown>
    repo: InstructionRepo
    projectId: string
  } {
    const db = openDb(join(base, 'db.sqlite'))
    dbs.push(db)
    const repo = new InstructionRepo(db)
    const projects = new ProjectRepo(db)
    const proj = projects.create(project, 'proj')
    const resolver = createInstructionResolver({ repo, touched: new TouchedPathRepo(db) })
    const mod = instructionHandlers({
      resolver,
      repo,
      projects,
      chats: new ChatRepo(db),
      getConfig: () => cfg
    })
    const h = mod({ db, blobs: new BlobStore(join(base, 'blobs')), emit: () => {} }) as Record<
      string,
      (p: unknown) => unknown
    >
    return { h, repo, projectId: proj.id }
  }

  it('escreve em <projeto>/.justtocode/<kind>s/<name>.<fmt> e não sobrescreve (EXISTS)', () => {
    const { h, repo, projectId } = handlers()
    const rule = repo.create({
      kind: 'rule',
      scope: 'project',
      scopeId: projectId,
      name: 'estilo',
      description: 'Estilo do código',
      trigger: 'always',
      body: 'Use tabs.',
      source: { type: 'app' }
    })
    const { path } = h['instructions.export']({ id: rule.id, projectId }) as { path: string }
    expect(path).toBe(join(project, '.justtocode', 'rules', 'estilo.md'))
    const back = parseInstructionText(readFileSync(path, 'utf8'), 'md')
    expect(back.meta).toMatchObject({ name: 'estilo', trigger: 'always', scope: 'project' })
    expect(back.body.trim()).toBe('Use tabs.')

    writeFileSync(path, 'editado à mão')
    expect(() => h['instructions.export']({ id: rule.id, projectId })).toThrow(
      expect.objectContaining({ code: 'EXISTS' })
    )
    expect(readFileSync(path, 'utf8')).toBe('editado à mão')
  })

  it('formato toml e nome com caracteres inválidos', () => {
    const { h, repo, projectId } = handlers()
    const cmd = repo.create({
      kind: 'command',
      scope: 'global',
      scopeId: null,
      name: 'git:commit',
      description: 'Commit',
      trigger: 'manual',
      body: 'Faça o commit de {{args}}',
      format: 'toml',
      source: { type: 'app' }
    })
    const { path } = h['instructions.export']({ id: cmd.id, projectId }) as { path: string }
    expect(path).toBe(join(project, '.justtocode', 'commands', 'git-commit.toml'))
    const back = parseInstructionText(readFileSync(path, 'utf8'), 'toml')
    expect(back.meta).toMatchObject({ name: 'git:commit', description: 'Commit' })
    expect(back.body.trim()).toBe('Faça o commit de {{args}}')
  })

  it('descoberto → READONLY; inexistente/projeto inválido → NOT_FOUND', () => {
    const { h, repo, projectId } = handlers()
    const g = write(join(home, '.claude/rules/style.md'), 'Global style.')
    expect(() =>
      h['instructions.export']({ id: stableInstructionId('file', g), projectId })
    ).toThrow(expect.objectContaining({ code: 'READONLY' }))
    expect(() => h['instructions.export']({ id: 'nada', projectId })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    const r = repo.create({
      kind: 'rule',
      scope: 'global',
      name: 'x',
      trigger: 'always',
      body: 'x',
      source: { type: 'app' }
    })
    expect(() => h['instructions.export']({ id: r.id, projectId: 'nada' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    expect(existsSync(join(project, '.justtocode'))).toBe(false)
  })

  it('exportFileName', () => {
    expect(exportFileName('a/b\\c:d')).toBe('a-b-c-d')
    expect(exportFileName('..')).toBe('')
    expect(exportFileName('con')).toBe('con-')
  })
})
