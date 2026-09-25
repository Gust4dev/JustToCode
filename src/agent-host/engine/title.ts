import type { AppConfig, Chat, StoredMessage } from '@shared/domain'
import type { ModelClient } from '../model/types'

export const DEFAULT_CHAT_TITLE = 'Novo chat'
const MAX_WORDS = 6
const MAX_CHARS = 80
const EXCERPT_CHARS = 1500
const TITLE_TIMEOUT_MS = 30_000

/** Marcador estável do prompt de título (os testes o usam para distinguir o request). */
export const TITLE_SYSTEM = `You write a short title for a chat between a user and a coding agent.
Rules:
- At most ${MAX_WORDS} words.
- Write it in the same language the user wrote in.
- No quotes, no trailing punctuation, no markdown, no emoji.
- Answer only with the title.`

/** Combos para gerar título, em ordem: lightCombo → defaultCombo → combo do chat. */
export function titleModels(cfg: AppConfig, chat: Chat): string[] {
  const out: string[] = []
  for (const m of [cfg.lightCombo, cfg.defaultCombo, chat.combo]) {
    const t = (m ?? '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

function textOf(m: StoredMessage): string {
  const c = m.message.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Primeira mensagem do usuário + primeira resposta com texto do assistente, recortadas. */
export function titleExcerpt(history: StoredMessage[]): string {
  const user = history.find((m) => m.message.role === 'user' && textOf(m).trim())
  const assistant = history.find((m) => m.message.role === 'assistant' && textOf(m).trim())
  const parts: string[] = []
  if (user) parts.push(`User: ${textOf(user).slice(0, EXCERPT_CHARS)}`)
  if (assistant) parts.push(`Assistant: ${textOf(assistant).slice(0, EXCERPT_CHARS)}`)
  return parts.join('\n\n')
}

/** Normaliza a resposta do modelo; '' quando não sobra nada útil. */
export function cleanTitle(raw: string): string {
  const line =
    raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l) ?? ''
  let t = line
    .replace(/^(title|título)\s*:\s*/i, '')
    .replace(/[*_`#]/g, '')
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .replace(/[.!?;:,]+$/, '')
    .trim()
  t = t.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS).join(' ')
  if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS).trim()
  return t
}

export interface TitleDeps {
  model: ModelClient
  getConfig: () => AppConfig
}

/** Gera um título para o chat (tenta cada combo em ordem). Lança se nenhuma servir. */
export async function generateChatTitle(
  d: TitleDeps,
  chat: Chat,
  history: StoredMessage[],
  signal?: AbortSignal
): Promise<string> {
  const excerpt = titleExcerpt(history)
  if (!excerpt) throw new Error('Nada para titular ainda')
  const models = titleModels(d.getConfig(), chat)
  if (!models.length) throw new Error('Nenhum modelo configurado para gerar título')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const errors: string[] = []
  try {
    for (const m of models) {
      if (controller.signal.aborted) break
      try {
        let text = ''
        const stream = d.model.stream(
          {
            model: m,
            messages: [
              { role: 'system', content: TITLE_SYSTEM },
              { role: 'user', content: `${excerpt}\n\nTitle:` }
            ],
            tools: []
          },
          controller.signal
        )
        for await (const ev of stream) if (ev.type === 'text_delta') text += ev.delta
        const title = cleanTitle(text)
        if (title) return title
        errors.push(`${m}: resposta vazia`)
      } catch (e) {
        errors.push(`${m}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  throw new Error(`Falha ao gerar título: ${errors.join('; ') || 'cancelado'}`)
}
