import type { Instruction, InstructionScope, MemoryOrigin } from '@shared/domain'
import type { InstructionRepo } from '../repo/instructions'
import type { InstructionContext } from '../ecosystem/resolver'

/**
 * Estado anterior de uma memória, guardado no `origin_json` para o `memory.undo`.
 * Campo INTERNO: não faz parte do contrato público `MemoryOrigin` (o JSON só ganha a chave
 * `previous`); `null` = a memória foi criada pelo save (undo apaga).
 */
export interface MemorySnapshot {
  name: string
  description: string
  body: string
  scope: InstructionScope
  scopeId: string | null
  origin: StoredMemoryOrigin | null
}

/** O que realmente fica no `origin_json` de uma memória. */
export interface StoredMemoryOrigin extends MemoryOrigin {
  previous?: MemorySnapshot | null
}

export interface MemorySaveInput {
  id?: string
  title: string
  content: string
  scope: InstructionScope
  /** Contexto de quem salva (resolve o `scopeId`). */
  chatId: string
  projectId: string | null
  groupId: string | null
  requestId: string | null
  thirdParty: string[]
}

export class MemoryError extends Error {}

/** Origem pública (sem o `previous` interno), para eventos/UI. */
export function publicOrigin(o: MemoryOrigin | null): MemoryOrigin | null {
  if (!o) return null
  return {
    chatId: o.chatId,
    requestId: o.requestId,
    thirdParty: [...(o.thirdParty ?? [])]
  }
}

/** Memória sem o campo interno `previous` na origem. */
export const publicMemory = (i: Instruction): Instruction => ({
  ...i,
  origin: publicOrigin(i.origin)
})

const stored = (i: Instruction): StoredMemoryOrigin | null =>
  (i.origin as StoredMemoryOrigin | null) ?? null

export const MEMORY_USAGE = [
  'You have a persistent memory shared across chats. The index below lists saved memories',
  'as `- [id] title` (most recent first). Use memory_read with the id to load one when it is',
  'relevant to the task.',
  'Save with memory_save when you learn something durable and useful later: user preferences,',
  'project conventions, decisions and their reasons, recurring pitfalls. Pick the narrowest',
  'scope that fits (chat, group, project, global).',
  'Update instead of duplicating: if a memory on the same subject exists, call memory_save with',
  'its id (or the same title in the same scope) and the full new content.',
  'Never save secrets (passwords, tokens, API keys, credentials) or personal data.'
].join('\n')

/** Regras de negócio da memória (sobre o `InstructionRepo`, `kind: memory`, `source: app`). */
export class MemoryService {
  constructor(private repo: InstructionRepo) {}

  private scopeIdFor(scope: InstructionScope, i: MemorySaveInput): string | null {
    switch (scope) {
      case 'global':
        return null
      case 'project':
        if (!i.projectId) throw new MemoryError('This chat has no project; use another scope.')
        return i.projectId
      case 'group':
        if (!i.groupId) throw new MemoryError('This chat is not in a group; use another scope.')
        return i.groupId
      case 'chat':
        return i.chatId
      default:
        throw new MemoryError(`Invalid scope: ${String(scope)}`)
    }
  }

  /** Busca por título (sem diferenciar maiúsculas) no mesmo escopo. */
  private findByTitle(
    scope: InstructionScope,
    scopeId: string | null,
    title: string
  ): Instruction | null {
    const key = title.toLowerCase()
    return (
      this.repo
        .list({ scope, scopeId, kind: 'memory' })
        .find((m) => m.name.trim().toLowerCase() === key) ?? null
    )
  }

  get(id: string): Instruction | null {
    const m = this.repo.get(id)
    return m && m.kind === 'memory' ? m : null
  }

  /** Cria ou atualiza (por id; senão por título igual no mesmo escopo). */
  save(i: MemorySaveInput): { instruction: Instruction; created: boolean } {
    const title = i.title.replace(/\s+/g, ' ').trim()
    if (!title) throw new MemoryError('Missing required parameter: title')
    if (typeof i.content !== 'string' || !i.content.trim()) {
      throw new MemoryError('Missing required parameter: content')
    }
    const scopeId = this.scopeIdFor(i.scope, i)
    let cur: Instruction | null = null
    if (i.id) {
      cur = this.get(i.id)
      if (!cur) throw new MemoryError(`Memory not found: ${i.id}`)
    } else {
      cur = this.findByTitle(i.scope, scopeId, title)
    }
    const base: MemoryOrigin = {
      chatId: i.chatId,
      requestId: i.requestId,
      thirdParty: [...new Set(i.thirdParty)]
    }
    if (!cur) {
      const origin: StoredMemoryOrigin = { ...base, previous: null }
      const instruction = this.repo.create({
        kind: 'memory',
        scope: i.scope,
        scopeId,
        name: title,
        description: '',
        trigger: 'model',
        body: i.content,
        source: { type: 'app' },
        origin
      })
      return { instruction, created: true }
    }
    const previous: MemorySnapshot = {
      name: cur.name,
      description: cur.description,
      body: cur.body,
      scope: cur.scope,
      scopeId: cur.scopeId,
      origin: stored(cur)
    }
    const origin: StoredMemoryOrigin = { ...base, previous }
    const instruction = this.repo.update(cur.id, {
      name: title,
      body: i.content,
      scope: i.scope,
      scopeId,
      origin
    })
    return { instruction, created: false }
  }

  /**
   * Desfaz o último save: apaga a memória criada ou restaura o estado anterior de uma
   * atualização (o anterior carrega a própria cadeia, então undos sucessivos voltam mais).
   * Memória sem histórico (criada fora do `memory_save`) é apagada.
   */
  undo(id: string): { deleted: boolean; instruction: Instruction | null } {
    const cur = this.get(id)
    if (!cur) throw new MemoryError(`Memory not found: ${id}`)
    const prev = stored(cur)?.previous ?? null
    if (!prev) {
      this.repo.remove(id)
      return { deleted: true, instruction: null }
    }
    const instruction = this.repo.update(id, {
      name: prev.name,
      description: prev.description,
      body: prev.body,
      scope: prev.scope,
      scopeId: prev.scopeId,
      origin: prev.origin
    })
    return { deleted: false, instruction }
  }

  /** Apaga as memórias cuja origem inclui a instrução de terceiros `thirdPartyId`. */
  deleteByOrigin(thirdPartyId: string): number {
    let n = 0
    for (const m of this.repo.list({ kind: 'memory' })) {
      if (m.origin?.thirdParty?.includes(thirdPartyId)) {
        this.repo.remove(m.id)
        n++
      }
    }
    return n
  }

  /** Memórias ativas do contexto, mais recentes primeiro. */
  forContext(c: Pick<InstructionContext, 'projectId' | 'groupId' | 'chatId'>): Instruction[] {
    return this.repo
      .listForContext({
        projectId: c.projectId,
        groupId: c.groupId,
        chatId: c.chatId,
        kind: 'memory'
      })
      .filter((m) => m.enabled)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  }

  /** Seção `# Memory` do prompt: instrução de uso + índice `- [id] título` (limitado). */
  section(c: InstructionContext): string {
    const max = Math.max(0, c.cfg.memoryIndexMaxLines ?? 150)
    const all = this.forContext(c)
    const shown = all.slice(0, max)
    const lines = shown.map((m) => `- [${m.id}] ${m.name.replace(/\s+/g, ' ').trim()}`)
    const rest = all.length - shown.length
    return [
      '# Memory',
      MEMORY_USAGE,
      '',
      ...(lines.length ? lines : ['(no memories saved yet)']),
      ...(rest > 0 ? [`(${rest} older memories not listed)`] : [])
    ].join('\n')
  }
}
