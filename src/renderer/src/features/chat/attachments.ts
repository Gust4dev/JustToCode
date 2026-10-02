import type { AttachmentUpload } from '@shared/api'
import type { AttachmentMeta, ContentPart } from '@shared/domain'
import {
  PDF_TEXT_PREFIX,
  classifyAttachment,
  extOf,
  rejectReason,
  type AttachmentClass
} from '@shared/attachmentKinds'

export interface DraftAttachment {
  id: string
  name: string
  mime: string
  bytes: number
  /** Data URL do arquivo (imagem: também é a prévia). */
  dataUrl: string
  cls: Exclude<AttachmentClass, 'unsupported'>
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

/** Classifica e valida; devolve o motivo da recusa (pt-BR) ou a classe aceita. */
export function checkFile(
  name: string,
  mime: string,
  bytes: number
): { cls: DraftAttachment['cls'] } | { error: string } {
  const cls = classifyAttachment(name, mime)
  const reason = rejectReason(cls, bytes)
  return reason || cls === 'unsupported' ? { error: reason ?? 'tipo não suportado' } : { cls }
}

export function readAttachment(file: File, cls: DraftAttachment['cls']): Promise<DraftAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler o arquivo'))
    reader.onload = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name || (cls === 'image' ? 'imagem.png' : 'arquivo'),
        mime:
          file.type ||
          (cls === 'pdf' ? 'application/pdf' : cls === 'image' ? 'image/png' : 'text/plain'),
        bytes: file.size,
        dataUrl: String(reader.result),
        cls
      })
    reader.readAsDataURL(file)
  })
}

/** Rótulo curto do tipo: "PNG", "PDF", "TS"… */
export const typeLabel = (name: string, mime: string): string =>
  (extOf(name) || mime.split('/').pop() || 'arquivo').toUpperCase().slice(0, 10)

/** Como o anexo vai ao modelo, antes do envio. */
export function plannedDelivery(cls: DraftAttachment['cls'], pdfNative: boolean): string {
  if (cls === 'image') return 'imagem'
  if (cls === 'text') return 'texto'
  return pdfNative ? 'PDF nativo' : 'PDF como texto'
}

type TextPart = Extract<ContentPart, { type: 'text' }>

/** É o bloco de texto que o host gerou para um anexo (código cercado ou PDF extraído)? */
const isAttachmentBlock = (text: string, names: string[]): boolean => {
  const first = text.split('\n', 1)[0]
  return names.some(
    (n) =>
      (first.startsWith('```') && first.endsWith(` ${n}`)) ||
      first.startsWith(`${PDF_TEXT_PREFIX}${n} (`)
  )
}

/** Texto digitado pelo usuário (sem os blocos dos anexos). */
export function userTextOf(content: string | ContentPart[], attachments: AttachmentMeta[]): string {
  if (typeof content === 'string') return content
  const names = attachments.filter((a) => a.kind === 'file').map((a) => a.name)
  return content
    .filter((p): p is TextPart => p.type === 'text' && !isAttachmentBlock(p.text, names))
    .map((p) => p.text)
    .join('\n')
}

/** Como o anexo foi enviado, lido do conteúdo gravado. */
export function sentDelivery(content: string | ContentPart[], a: AttachmentMeta): string {
  if (a.kind === 'image') return 'imagem'
  if (typeof content === 'string') return 'arquivo'
  if (content.some((p) => p.type === 'file' && p.file.filename === a.name)) return 'PDF nativo'
  const block = content.find(
    (p): p is TextPart => p.type === 'text' && isAttachmentBlock(p.text, [a.name])
  )
  if (!block) return 'arquivo'
  return block.text.startsWith(PDF_TEXT_PREFIX) ? 'PDF como texto' : 'texto'
}

export function toUpload(a: DraftAttachment): AttachmentUpload {
  const comma = a.dataUrl.indexOf(',')
  return { name: a.name, mime: a.mime, dataBase64: a.dataUrl.slice(comma + 1) }
}

/**
 * Prévias locais das imagens enviadas (string vazia para arquivos) nesta sessão, por id da mensagem gravada.
 * O host guarda só o hash do blob; sem isso, a mensagem recarregada mostra um ícone no lugar.
 */
export const sentPreviews = new Map<string, string[]>()
