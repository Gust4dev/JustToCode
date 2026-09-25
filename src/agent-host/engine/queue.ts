import type { AttachmentUpload } from '@shared/api'
import type { AttachmentMeta, QueuedMessage, QueueState } from '@shared/domain'
import type { EngineEvent } from '@shared/events'
import { RpcError } from '@shared/rpc'
import type { BlobStore } from '../blobs'
import type { QueueRepo } from '../repo/queue'
import { newId } from '../ids'

export interface ChatQueueDeps {
  repo: QueueRepo
  blobs: BlobStore
  emit(e: EngineEvent): void
  /** Chat ocupado (turno ou compactação em andamento). */
  isBusy(chatId: string): boolean
  /** Inicia um turno com a mensagem (mesmo caminho do `send` direto); lança se não puder. */
  start(chatId: string, text: string, attachments: AttachmentUpload[]): void
}

export interface ChatQueue {
  /** `true` quando a mensagem deve ir para a fila em vez de rodar agora. */
  shouldQueue(chatId: string): boolean
  enqueue(chatId: string, text: string, attachments: AttachmentUpload[]): QueuedMessage
  /** Envio direto com a fila vazia: limpa uma pausa que tenha sobrado. */
  clearStalePause(chatId: string): void
  /** Turno/compactação terminou bem: drena o próximo item (assíncrono). */
  succeeded(chatId: string): void
  /** Turno terminou com erro/cancelamento: pausa a fila (se houver itens). */
  failed(chatId: string, reason: string): void
  get(chatId: string): QueueState
  remove(id: string): QueueState
  edit(id: string, text: string): QueueState
  resume(chatId: string): QueueState
}

export function createChatQueue(d: ChatQueueDeps): ChatQueue {
  const changed = (chatId: string): QueueState => {
    const queue = d.repo.state(chatId)
    d.emit({ type: 'queue_changed', queue })
    return queue
  }

  const mustGet = (id: string): QueuedMessage => {
    const item = d.repo.get(id)
    if (!item) throw new RpcError('Item da fila não encontrado', 'NOT_FOUND')
    return item
  }

  const toUploads = (metas: AttachmentMeta[]): AttachmentUpload[] => {
    const out: AttachmentUpload[] = []
    for (const m of metas) {
      const buf = d.blobs.get(m.blobHash)
      if (buf) out.push({ name: m.name, mime: m.mime, dataBase64: buf.toString('base64') })
    }
    return out
  }

  const pause = (chatId: string, reason: string): void => {
    if (!d.repo.peek(chatId)) return
    d.repo.setPaused(chatId, true, reason)
    changed(chatId)
  }

  /** Envia o próximo item; falha ao iniciar pausa a fila com o motivo (o item fica no topo). */
  const drain = (chatId: string): void => {
    if (d.isBusy(chatId)) return
    const s = d.repo.state(chatId)
    if (s.paused || !s.items.length) return
    const item = s.items[0]
    try {
      d.start(chatId, item.text, toUploads(item.attachments))
    } catch (e) {
      d.repo.setPaused(chatId, true, e instanceof Error ? e.message : String(e))
      changed(chatId)
      return
    }
    d.repo.remove(item.id)
    changed(chatId)
  }

  const schedule = (chatId: string): void => {
    setImmediate(() => drain(chatId))
  }

  return {
    shouldQueue(chatId) {
      return d.isBusy(chatId) || d.repo.peek(chatId) !== null
    },

    enqueue(chatId, text, attachments) {
      const metas: AttachmentMeta[] = attachments.map((a) => {
        const buf = Buffer.from(a.dataBase64, 'base64')
        return {
          id: newId(),
          kind: a.mime.startsWith('image/') ? 'image' : 'file',
          name: a.name,
          blobHash: d.blobs.put(buf),
          mime: a.mime,
          bytes: buf.length,
          // dimensões são lidas de novo quando o item vira mensagem
          width: null,
          height: null
        }
      })
      const item = d.repo.enqueue(chatId, text, metas)
      changed(chatId)
      // Chat livre com itens pendentes (ex.: sobra de um reinício): drena agora.
      schedule(chatId)
      return item
    },

    clearStalePause(chatId) {
      const s = d.repo.state(chatId)
      if (s.paused && !s.items.length) {
        d.repo.setPaused(chatId, false)
        changed(chatId)
      }
    },

    succeeded(chatId) {
      schedule(chatId)
    },

    failed(chatId, reason) {
      pause(chatId, reason)
    },

    get(chatId) {
      return d.repo.state(chatId)
    },

    remove(id) {
      const item = mustGet(id)
      d.repo.remove(id)
      const s = d.repo.state(item.chatId)
      // Fila esvaziada: não sobra banner de pausa.
      if (s.paused && !s.items.length) d.repo.setPaused(item.chatId, false)
      return changed(item.chatId)
    },

    edit(id, text) {
      const item = mustGet(id)
      if (!text.trim() && !item.attachments.length) {
        throw new RpcError('Mensagem vazia', 'EMPTY_MESSAGE')
      }
      d.repo.editText(id, text)
      return changed(item.chatId)
    },

    resume(chatId) {
      d.repo.setPaused(chatId, false)
      changed(chatId)
      drain(chatId)
      return d.repo.state(chatId)
    }
  }
}
