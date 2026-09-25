import type { Instruction, InstructionScope } from '@shared/domain'
import { MemoryError, publicMemory, type MemoryService } from '../memory/memory'
import type { Tool, ToolContext } from './types'

export const MEMORY_SAVE_TOOL = 'memory_save'
export const MEMORY_READ_TOOL = 'memory_read'

const SCOPES: InstructionScope[] = ['global', 'project', 'group', 'chat']

export interface MemoryToolDeps {
  memory: MemoryService
  /** Grupo do chat (resolve o escopo `group`). */
  groupIdOf(chatId: string): string | null
  /** Request do modelo que pediu a ferramenta (o último do chat). */
  requestIdOf(chatId: string): string | null
  /** Ids das instruções de terceiros (`source.type === 'github'`) ativas no turno do chat. */
  thirdPartyOf(chatId: string): string[]
  /** Aviso ao renderer (card "memória salva"). */
  onSaved(e: {
    chatId: string
    instruction: Instruction
    toolCallId: string
    created: boolean
  }): void
}

interface SaveArgs {
  id?: string
  title: string
  content: string
  scope: InstructionScope
}

interface ReadArgs {
  id: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** `memory_save` (cria/atualiza, salva sem aprovação) e `memory_read`. */
export function createMemoryTools(d: MemoryToolDeps): [Tool<SaveArgs>, Tool<ReadArgs>] {
  const save: Tool<SaveArgs> = {
    name: MEMORY_SAVE_TOOL,
    // Salvar é automático (decisão do usuário): a UI mostra um card com editar/desfazer.
    kind: 'read',
    description:
      'Save a durable memory (shared with future chats). Creates a new memory, or updates an ' +
      'existing one when `id` is given or a memory with the same title exists in the same scope. ' +
      'Content replaces the previous content entirely. Never save secrets.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the memory to update (from the Memory index).' },
        title: { type: 'string', description: 'Short title shown in the memory index.' },
        content: { type: 'string', description: 'Full memory content (markdown).' },
        scope: {
          type: 'string',
          enum: SCOPES,
          description:
            'Where the memory applies: chat (this chat), group (chats of this group), ' +
            'project (this project), global (all projects).'
        }
      },
      required: ['title', 'content', 'scope'],
      additionalProperties: false
    },
    summarize: (a) => `memory ${str(a?.title)}`,
    async run(args, ctx: ToolContext) {
      const scope = str(args?.scope) as InstructionScope
      if (!SCOPES.includes(scope)) {
        return {
          content: `Invalid scope: ${str(args?.scope)}. Use ${SCOPES.join(', ')}.`,
          isError: true
        }
      }
      try {
        const id = str(args?.id)
          .trim()
          .replace(/^\[|\]$/g, '')
        const r = d.memory.save({
          id: id || undefined,
          title: str(args?.title),
          content: str(args?.content),
          scope,
          chatId: ctx.chatId,
          projectId: ctx.projectId || null,
          groupId: d.groupIdOf(ctx.chatId),
          requestId: d.requestIdOf(ctx.chatId),
          thirdParty: d.thirdPartyOf(ctx.chatId)
        })
        const instruction = publicMemory(r.instruction)
        d.onSaved({
          chatId: ctx.chatId,
          instruction,
          toolCallId: ctx.toolCallId,
          created: r.created
        })
        return {
          content: `Memory ${r.created ? 'created' : 'updated'}: [${instruction.id}] ${instruction.name} (${instruction.scope} scope)`
        }
      } catch (e) {
        if (e instanceof MemoryError) return { content: e.message, isError: true }
        throw e
      }
    }
  }

  const read: Tool<ReadArgs> = {
    name: MEMORY_READ_TOOL,
    kind: 'read',
    description: 'Read the full content of a saved memory by its id (from the Memory index).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory id.' } },
      required: ['id'],
      additionalProperties: false
    },
    summarize: (a) => `memory ${str(a?.id)}`,
    async run(args) {
      const id = str(args?.id)
        .trim()
        .replace(/^\[|\]$/g, '')
      if (!id) return { content: 'Missing required parameter: id', isError: true }
      const m = d.memory.get(id)
      if (!m) return { content: `Memory not found: ${id}`, isError: true }
      return { content: `Memory [${m.id}] ${m.name} (${m.scope} scope)\n\n${m.body.trim()}` }
    }
  }

  return [save, read]
}
