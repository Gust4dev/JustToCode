import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { Instruction, InstructionScope, InstructionTrigger } from '@shared/domain'

export interface Frontmatter {
  data: Record<string, unknown>
  body: string
}

const FENCE = /^---[ \t]*$/

function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

function scalar(v: string): unknown {
  const t = v.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null' || t === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return unquote(t)
}

function inlineList(v: string): string[] {
  const inner = v.trim().slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(',')
    .map((s) => unquote(s))
    .filter((s) => s !== '')
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * YAML simples de frontmatter: `key: value`, listas `[a, b]` ou `- item`, e blocos `|`/`>`.
 * Sem frontmatter (ou sem fechamento) → `data` vazio e `body` = texto inteiro.
 */
export function parseFrontmatter(md: string): Frontmatter {
  const text = md.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (!lines.length || !FENCE.test(lines[0])) return { data: {}, body: text }
  const end = lines.findIndex((l, i) => i > 0 && FENCE.test(l))
  if (end < 0) return { data: {}, body: text }

  const data: Record<string, unknown> = {}
  const head = lines.slice(1, end)
  for (let i = 0; i < head.length; i++) {
    const line = head[i]
    if (!line.trim() || line.trimStart().startsWith('#') || indentOf(line) > 0) continue
    const m = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    const rest = m[2].trim()
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = inlineList(rest)
    } else if (rest === '|' || rest === '>' || /^[|>][+-]?$/.test(rest)) {
      const block: string[] = []
      while (i + 1 < head.length && (head[i + 1].trim() === '' || indentOf(head[i + 1]) > 0)) {
        block.push(head[++i].trim())
      }
      while (block.length && block[block.length - 1] === '') block.pop()
      data[key] = rest.startsWith('|')
        ? block.join('\n')
        : block.join(' ').replace(/\s+/g, ' ').trim()
    } else if (rest === '') {
      const items: string[] = []
      while (i + 1 < head.length && /^\s*-\s+/.test(head[i + 1])) {
        items.push(unquote(head[++i].replace(/^\s*-\s+/, '')))
      }
      data[key] = items.length ? items : ''
    } else {
      data[key] = scalar(rest)
    }
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\s*\n/, '')
  return { data, body }
}

/** Valor do frontmatter como texto (vazio se ausente). */
export function fmString(data: Record<string, unknown>, key: string): string {
  const v = data[key]
  if (v === undefined || v === null) return ''
  if (Array.isArray(v)) return v.join(', ')
  return String(v).trim()
}

export type InstructionFormat = 'md' | 'toml'

/** Campos de instrução lidos do frontmatter `.md` ou do `.toml` (ausente = `undefined`). */
export interface InstructionMeta {
  name?: string
  description?: string
  trigger?: InstructionTrigger
  globs?: string[]
  /** Nome do `/comando` (sem a barra). */
  command?: string
  scope?: InstructionScope
}

export interface InstructionFile {
  format: InstructionFormat
  data: Record<string, unknown>
  body: string
  meta: InstructionMeta
}

const TRIGGERS: readonly InstructionTrigger[] = ['always', 'glob', 'model', 'manual']
const SCOPES: readonly InstructionScope[] = ['global', 'project', 'group', 'chat']

/** `.toml` → `toml`; qualquer outra extensão → `md`. */
export function formatOf(path: string): InstructionFormat {
  return path.toLowerCase().endsWith('.toml') ? 'toml' : 'md'
}

function globList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined
  const raw = Array.isArray(v) ? v.map((x) => String(x)) : String(v).split(',')
  const out = raw.map((s) => s.trim()).filter((s) => s !== '')
  return out.length ? out : undefined
}

/**
 * Campos de instrução de um frontmatter/tabela TOML: `name`, `description`, `trigger`,
 * `globs` (lista ou texto separado por vírgula; `paths` do Claude Code como alias), `command`
 * (sem a `/` inicial) e `scope`. Valores inválidos são ignorados.
 */
export function instructionMeta(data: Record<string, unknown>): InstructionMeta {
  const meta: InstructionMeta = {}
  const name = fmString(data, 'name')
  if (name) meta.name = name
  const description = fmString(data, 'description').replace(/\s+/g, ' ').trim()
  if (description) meta.description = description
  const trigger = fmString(data, 'trigger').toLowerCase() as InstructionTrigger
  if (TRIGGERS.includes(trigger)) meta.trigger = trigger
  const globs = globList(data.globs) ?? globList(data.paths)
  if (globs) meta.globs = globs
  const command = fmString(data, 'command').replace(/^\//, '').trim()
  if (command) meta.command = command
  const scope = fmString(data, 'scope').toLowerCase() as InstructionScope
  if (SCOPES.includes(scope)) meta.scope = scope
  return meta
}

/**
 * TOML nativo: tabela de topo com os mesmos campos do frontmatter; o corpo vem de `prompt`
 * (comandos do Gemini CLI) ou `body`. TOML inválido → sem dados e corpo vazio.
 */
export function parseTomlInstruction(text: string): {
  data: Record<string, unknown>
  body: string
} {
  let data: Record<string, unknown>
  try {
    data = parseToml(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<
      string,
      unknown
    >
  } catch {
    return { data: {}, body: '' }
  }
  const pick = (k: string): string | null =>
    typeof data[k] === 'string' ? (data[k] as string) : null
  return { data, body: pick('prompt') ?? pick('body') ?? '' }
}

/** Lê o texto de um arquivo de instrução no formato indicado (`md` com frontmatter ou `toml`). */
export function parseInstructionText(text: string, format: InstructionFormat): InstructionFile {
  const { data, body } = format === 'toml' ? parseTomlInstruction(text) : parseFrontmatter(text)
  return { format, data, body, meta: instructionMeta(data) }
}

/** Texto YAML de um escalar: puro quando seguro, senão entre aspas duplas. */
function yamlScalar(v: string): string {
  return /^[A-Za-z0-9_][\w .,/@()+-]*$/.test(v) && v.trim() === v ? v : JSON.stringify(v)
}

type SerializableInstruction = Pick<
  Instruction,
  'name' | 'description' | 'trigger' | 'globs' | 'scope' | 'body'
>

// eslint-disable-next-line no-control-regex
const TOML_LITERAL_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f]|'''/

/**
 * Serializa uma instrução no formato do arquivo (`md` com frontmatter ou `toml` com `prompt`);
 * o resultado é lido de volta por `parseInstructionText` com os mesmos campos.
 */
export function serializeInstruction(
  i: SerializableInstruction,
  format: InstructionFormat
): string {
  const description = i.description.replace(/\s+/g, ' ').trim()
  const body = i.body.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (format === 'toml') {
    const meta: Record<string, unknown> = { name: i.name }
    if (description) meta.description = description
    meta.trigger = i.trigger
    if (i.globs.length) meta.globs = i.globs
    meta.scope = i.scope
    const head = stringifyToml(meta).trim()
    // Literal multilinha quando possível (legível); senão string básica escapada.
    const prompt = TOML_LITERAL_UNSAFE.test(body)
      ? stringifyToml({ prompt: body }).trim()
      : `prompt = '''\n${body}\n'''`
    return `${head}\n${prompt}\n`
  }
  const lines = ['---', `name: ${yamlScalar(i.name)}`]
  if (description) lines.push(`description: ${yamlScalar(description)}`)
  lines.push(`trigger: ${i.trigger}`)
  if (i.globs.length) {
    lines.push('globs:')
    for (const g of i.globs) lines.push(`  - ${JSON.stringify(g)}`)
  }
  lines.push(`scope: ${i.scope}`, '---', '')
  return `${lines.join('\n')}${body}\n`
}
