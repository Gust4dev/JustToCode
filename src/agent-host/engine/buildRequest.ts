import type { ChatMessage, ContentPart, StoredMessage } from '@shared/domain'
import type { BlobStore } from '../blobs'
import type { ChatRequest, ChatRequestTool } from '../model/types'
import type { Tool } from '../tools/types'

export const INTERRUPTED_TOOL_RESULT = 'Tool call was interrupted before producing a result.'

export function toRequestTool(t: Tool): ChatRequestTool {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }
}

/** Detecta o mime de uma imagem pelos bytes iniciais. */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return null
}

/**
 * Histórico → mensagens do request. Garante que toda tool call do assistente tenha uma
 * mensagem `tool` correspondente (ex.: turno interrompido por crash), senão o provider rejeita.
 */
export function historyMessages(
  history: StoredMessage[],
  mapUser?: (m: StoredMessage) => ChatMessage
): ChatMessage[] {
  const out: ChatMessage[] = []
  let open: string[] = []
  const closeOpen = (): void => {
    for (const id of open)
      out.push({ role: 'tool', tool_call_id: id, content: INTERRUPTED_TOOL_RESULT })
    open = []
  }
  for (const sm of history) {
    const m = sm.message
    if (m.role === 'tool') {
      if (!open.includes(m.tool_call_id)) continue // resultado órfão: descarta
      open = open.filter((id) => id !== m.tool_call_id)
      out.push(m)
      continue
    }
    closeOpen()
    if (m.role === 'assistant') {
      out.push(m)
      open = (m.tool_calls ?? []).map((c) => c.id)
    } else if (m.role === 'user' && mapUser) {
      out.push(mapUser(sm))
    } else {
      out.push(m)
    }
  }
  closeOpen()
  return out
}

function resolveImages(sm: StoredMessage, blobs: BlobStore): ChatMessage {
  const m = sm.message
  if (m.role !== 'user' || typeof m.content === 'string') return m
  const parts: ContentPart[] = m.content.map((p) => {
    if (p.type !== 'image_url' || !p.image_url.url.startsWith('blob:')) return p
    const hash = p.image_url.url.slice('blob:'.length)
    const buf = blobs.get(hash)
    if (!buf) return { type: 'text', text: '[image unavailable]' }
    const mime =
      sm.attachments.find((a) => a.blobHash === hash)?.mime ?? sniffImageMime(buf) ?? 'image/png'
    return {
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${buf.toString('base64')}` }
    }
  })
  return { role: 'user', content: parts }
}

/**
 * Histórico ativo na ordem do request: sem compactadas; o summary vigente (`kind: 'summary'`)
 * vem primeiro, independente do seq; as demais seguem por seq.
 */
export function activeHistory(history: StoredMessage[]): StoredMessage[] {
  const live = history.filter((m) => !m.compacted).sort((a, b) => a.seq - b.seq)
  return [...live.filter((m) => m.kind === 'summary'), ...live.filter((m) => m.kind !== 'summary')]
}

/** Monta o request: system + summary vigente + histórico não compactado + ferramentas; troca `blob:<hash>` por data URL. */
export function buildRequest(p: {
  model: string
  system: string
  history: StoredMessage[]
  tools: Tool[]
  blobs: BlobStore
}): ChatRequest {
  return {
    model: p.model,
    messages: [
      { role: 'system', content: p.system },
      ...historyMessages(activeHistory(p.history), (sm) => resolveImages(sm, p.blobs))
    ],
    tools: p.tools.map(toRequestTool)
  }
}
