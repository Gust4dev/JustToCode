import { Tiktoken } from 'js-tiktoken/lite'
import o200k_base from 'js-tiktoken/ranks/o200k_base'
import type { ChatMessage } from '@shared/domain'

export const IMAGE_TOKENS = 1600
const MESSAGE_OVERHEAD = 4
const SAFETY_FACTOR = 1.1

let enc: Tiktoken | null = null
const encoder = (): Tiktoken => (enc ??= new Tiktoken(o200k_base))

/**
 * Carrega o encoder o200k agora (~200 ms, síncrono). O host chama isto logo após registrar
 * os handlers para que o primeiro envio não trave o event loop.
 */
export function warmTokenizer(): void {
  encoder()
}

/** Tokens do texto em o200k_base. Tokens especiais são tratados como texto comum. */
export function estimateText(s: string): number {
  if (!s) return 0
  return encoder().encode(s, [], []).length
}

/** (texto + 4) × 1.10, arredondado para cima; cada imagem soma IMAGE_TOKENS. */
export function estimateMessage(m: ChatMessage): number {
  let text = 0
  let images = 0
  switch (m.role) {
    case 'system':
    case 'tool':
      text = estimateText(m.content)
      break
    case 'user':
      if (typeof m.content === 'string') text = estimateText(m.content)
      else
        for (const p of m.content) {
          if (p.type === 'text') text += estimateText(p.text)
          else images += 1
        }
      break
    case 'assistant':
      text = estimateText(m.content ?? '')
      for (const tc of m.tool_calls ?? []) {
        text += estimateText(tc.function.name) + estimateText(tc.function.arguments)
      }
      break
  }
  return Math.ceil((text + MESSAGE_OVERHEAD) * SAFETY_FACTOR) + images * IMAGE_TOKENS
}

export function estimateMessages(ms: ChatMessage[]): number {
  let total = 0
  for (const m of ms) total += estimateMessage(m)
  return total
}
