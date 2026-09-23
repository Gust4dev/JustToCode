import { newId } from '../ids'

export interface CommandWindow {
  id: string
  projectId: string
  chatId: string
  toolCallId: string
  start: number
  /** null = comando em andamento. */
  end: number | null
}

/** Janelas fechadas continuam consultáveis por este tempo (eventos atrasados do watcher). */
const KEEP_CLOSED_MS = 60_000

/**
 * Janelas de execução de comandos por projeto. Usadas para marcar mudanças como ambíguas quando
 * comandos de chats diferentes se sobrepõem e para o watcher ignorar o que um comando registra.
 */
export class CommandWindowRegistry {
  private windows = new Map<string, CommandWindow>()

  constructor(private now: () => number = Date.now) {}

  open(w: Omit<CommandWindow, 'id' | 'start' | 'end'>): CommandWindow {
    const win: CommandWindow = { ...w, id: newId(), start: this.now(), end: null }
    this.windows.set(win.id, win)
    return { ...win }
  }

  close(id: string): void {
    const w = this.windows.get(id)
    if (w && w.end === null) w.end = this.now()
    this.prune()
  }

  /** Janelas de OUTROS chats do projeto cujo intervalo cruza o de `w` (end null = em andamento). */
  overlapping(projectId: string, w: CommandWindow): CommandWindow[] {
    const wEnd = this.windows.get(w.id)?.end ?? w.end
    // Limites estritos: um comando que termina no mesmo ms em que outro começa não se sobrepõe.
    return this.list(projectId).filter(
      (o) =>
        o.id !== w.id &&
        o.chatId !== w.chatId &&
        (wEnd === null || o.start < wEnd) &&
        (o.end === null || o.end > w.start)
    )
  }

  /** Janelas do projeto ativas no instante t. */
  activeAt(projectId: string, t: number): CommandWindow[] {
    return this.list(projectId).filter((o) => o.start <= t && (o.end === null || o.end >= t))
  }

  private list(projectId: string): CommandWindow[] {
    return [...this.windows.values()]
      .filter((o) => o.projectId === projectId)
      .map((o) => ({ ...o }))
  }

  /** Remove janelas fechadas que já não podem cruzar nenhuma aberta nem eventos recentes. */
  private prune(): void {
    let limit = this.now() - KEEP_CLOSED_MS
    for (const o of this.windows.values()) if (o.end === null) limit = Math.min(limit, o.start)
    for (const [id, o] of this.windows) if (o.end !== null && o.end < limit) this.windows.delete(id)
  }
}

/** Escritas recentes feitas por ferramenta, para o watcher não registrá-las de novo como externas. */
export class RecentToolWrites {
  private writes = new Map<string, { hash: string | null; at: number }>()

  constructor(private now: () => number = Date.now) {}

  mark(projectId: string, rel: string, afterHash: string | null): void {
    this.writes.set(`${projectId}\0${rel}`, { hash: afterHash, at: this.now() })
    if (this.writes.size > 1000) {
      const limit = this.now() - 60_000
      for (const [k, v] of this.writes) if (v.at < limit) this.writes.delete(k)
    }
  }

  isRecent(projectId: string, rel: string, hash: string | null, withinMs = 5000): boolean {
    const w = this.writes.get(`${projectId}\0${rel}`)
    return !!w && w.hash === hash && this.now() - w.at <= withinMs
  }
}
