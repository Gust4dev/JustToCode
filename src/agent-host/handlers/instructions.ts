import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  AppConfig,
  Instruction,
  InstructionKind,
  InstructionScope,
  InstructionTrigger
} from '@shared/domain'
import type { HostParams, HostResult } from '@shared/api'
import { RpcError } from '@shared/rpc'
import type { HandlerModule } from '../context'
import type { ProjectRepo } from '../repo/projects'
import type { ChatRepo } from '../repo/chats'
import type { InstructionRepo } from '../repo/instructions'
import type { InstructionContext, InstructionResolver } from '../ecosystem/resolver'
import { discoverInstructions } from '../ecosystem/instructionSources'
import { serializeInstruction } from '../ecosystem/frontmatter'

export interface InstructionHandlerDeps {
  resolver: InstructionResolver
  repo: InstructionRepo
  projects: ProjectRepo
  chats: ChatRepo
  getConfig: () => AppConfig
}

const KINDS: InstructionKind[] = ['rule', 'command', 'skill', 'memory']
const SCOPES: InstructionScope[] = ['global', 'project', 'group', 'chat']
const TRIGGERS: InstructionTrigger[] = ['always', 'glob', 'model', 'manual']
/** Raiz sem projeto: só os itens globais da descoberta são usados. */
const NO_PROJECT_ROOT = join(tmpdir(), 'justtocode-no-project')

/** Pasta (no projeto) para onde `instructions.export` escreve os itens do app. */
export const EXPORT_DIR = '.justtocode'

/** Nome de arquivo seguro a partir do nome da instrução (sem separadores nem reservados). */
export function exportFileName(name: string): string {
  const safe = name
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/^[.\s-]+|[.\s]+$/g, '')
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(safe) ? `${safe}-` : safe
}

const invalid = (msg: string): RpcError => new RpcError(msg, 'INVALID_PARAMS')
const readonlyError = (): RpcError =>
  new RpcError('Instrução somente leitura (descoberta no disco ou instalada)', 'READONLY')

/** Handlers `instructions.*` (lista, salvar itens do app, excluir, liga/desliga, ativas do chat). */
export const instructionHandlers =
  (d: InstructionHandlerDeps): HandlerModule =>
  () => {
    const contextFor = (p: {
      projectId?: string
      groupId?: string
      chatId?: string
    }): InstructionContext | null => {
      const cfg = d.getConfig()
      const chat = p.chatId ? d.chats.get(p.chatId) : null
      if (p.chatId && !chat) throw new RpcError('Chat não encontrado', 'NOT_FOUND')
      const projectId = p.projectId ?? chat?.projectId
      if (!projectId) return null
      const project = d.projects.get(projectId)
      if (!project) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
      return {
        projectRoot: project.path,
        projectId: project.id,
        groupId: p.groupId ?? chat?.groupId ?? null,
        chatId: chat?.id ?? null,
        cfg
      }
    }

    /** Descobertos globais (sem projeto) com os toggles aplicados. */
    const globalDiscovered = (): Instruction[] =>
      discoverInstructions(NO_PROJECT_ROOT, null, d.getConfig(), d.repo.toggles()).filter(
        (i) => i.scope === 'global'
      )

    /** Procura um descoberto pelo id (globais e de cada projeto conhecido). */
    const findDiscovered = (id: string): Instruction | null => {
      const cfg = d.getConfig()
      const toggles = d.repo.toggles()
      const hit = globalDiscovered().find((i) => i.id === id)
      if (hit) return hit
      for (const p of d.projects.list()) {
        const found = discoverInstructions(p.path, p.id, cfg, toggles).find((i) => i.id === id)
        if (found) return found
      }
      return null
    }

    return {
      'instructions.list': (
        p: HostParams<'instructions.list'>
      ): HostResult<'instructions.list'> => {
        const params = p ?? {}
        const c = contextFor(params)
        const all = c ? d.resolver.candidates(c) : [...globalDiscovered(), ...d.repo.list()]
        return params.kind ? all.filter((i) => i.kind === params.kind) : all
      },

      'instructions.save': (
        p: HostParams<'instructions.save'>
      ): HostResult<'instructions.save'> => {
        if (!p || typeof p !== 'object') throw invalid('Parâmetros inválidos')
        if (p.source && p.source.type !== 'app') throw readonlyError()
        if (!KINDS.includes(p.kind)) throw invalid('Tipo inválido')
        if (!SCOPES.includes(p.scope)) throw invalid('Escopo inválido')
        if (!TRIGGERS.includes(p.trigger)) throw invalid('Gatilho inválido')
        const name = typeof p.name === 'string' ? p.name.trim() : ''
        if (!name) throw invalid('Nome vazio')
        if (typeof p.body !== 'string') throw invalid('Conteúdo inválido')
        const scopeId = p.scope === 'global' ? null : (p.scopeId ?? null)
        if (p.scope !== 'global' && !scopeId) throw invalid('Escopo sem id')
        if (p.globs !== undefined && !Array.isArray(p.globs)) throw invalid('Globs inválidos')
        const fields = {
          kind: p.kind,
          scope: p.scope,
          scopeId,
          name,
          trigger: p.trigger,
          body: p.body,
          ...(p.description !== undefined ? { description: String(p.description) } : {}),
          ...(p.globs !== undefined ? { globs: p.globs.map(String) } : {}),
          ...(p.format !== undefined ? { format: p.format } : {}),
          ...(p.enabled !== undefined ? { enabled: !!p.enabled } : {}),
          ...(p.origin !== undefined ? { origin: p.origin } : {})
        }
        if (p.id) {
          const cur = d.repo.get(p.id)
          if (!cur) {
            if (findDiscovered(p.id)) throw readonlyError()
            throw new RpcError('Instrução não encontrada', 'NOT_FOUND')
          }
          if (cur.source.type !== 'app') throw readonlyError()
          return d.repo.update(p.id, fields)
        }
        return d.repo.create({ ...fields, source: { type: 'app' } })
      },

      'instructions.delete': ({
        id
      }: HostParams<'instructions.delete'>): HostResult<'instructions.delete'> => {
        const cur = d.repo.get(id)
        if (!cur) {
          if (findDiscovered(id)) throw readonlyError()
          throw new RpcError('Instrução não encontrada', 'NOT_FOUND')
        }
        if (cur.readonly) throw readonlyError()
        d.repo.remove(id)
        return null
      },

      'instructions.setEnabled': ({
        id,
        enabled
      }: HostParams<'instructions.setEnabled'>): HostResult<'instructions.setEnabled'> => {
        const on = !!enabled
        if (d.repo.get(id)) return d.repo.setEnabled(id, on)
        const found = findDiscovered(id)
        if (!found) throw new RpcError('Instrução não encontrada', 'NOT_FOUND')
        d.repo.setToggle(id, on)
        return { ...found, enabled: on }
      },

      'instructions.export': ({
        id,
        projectId
      }: HostParams<'instructions.export'>): HostResult<'instructions.export'> => {
        const cur = d.repo.get(id)
        if (!cur) {
          if (findDiscovered(id)) throw readonlyError()
          throw new RpcError('Instrução não encontrada', 'NOT_FOUND')
        }
        if (cur.source.type !== 'app') throw readonlyError()
        const project = d.projects.get(projectId)
        if (!project) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
        const file = exportFileName(cur.name)
        if (!file) throw invalid('Nome inválido para arquivo')
        const format = cur.format === 'toml' ? 'toml' : 'md'
        const dir = join(resolve(project.path), EXPORT_DIR, `${cur.kind}s`)
        const path = join(dir, `${file}.${format}`)
        if (existsSync(path)) throw new RpcError(`Arquivo já existe: ${path}`, 'EXISTS')
        mkdirSync(dir, { recursive: true })
        // `wx`: nunca sobrescreve, mesmo em corrida com outro processo.
        try {
          writeFileSync(path, serializeInstruction(cur, format), { encoding: 'utf8', flag: 'wx' })
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new RpcError(`Arquivo já existe: ${path}`, 'EXISTS')
          }
          throw e
        }
        return { path }
      },

      'instructions.active': ({
        chatId
      }: HostParams<'instructions.active'>): HostResult<'instructions.active'> => {
        const c = contextFor({ chatId })
        if (!c) throw new RpcError('Chat não encontrado', 'NOT_FOUND')
        // Resolve na hora (reflete toggles/edições recentes); também atualiza o cache do chat.
        return d.resolver.resolve(c).active
      }
    }
  }
