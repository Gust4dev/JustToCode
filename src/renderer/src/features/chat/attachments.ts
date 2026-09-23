import type { AttachmentUpload } from '@shared/api'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export interface DraftAttachment {
  id: string
  name: string
  mime: string
  bytes: number
  dataUrl: string
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

export const isImageFile = (f: File): boolean => f.type.startsWith('image/')

export function readImageFile(file: File): Promise<DraftAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler o arquivo'))
    reader.onload = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name || 'imagem.png',
        mime: file.type || 'image/png',
        bytes: file.size,
        dataUrl: String(reader.result)
      })
    reader.readAsDataURL(file)
  })
}

export function toUpload(a: DraftAttachment): AttachmentUpload {
  const comma = a.dataUrl.indexOf(',')
  return { name: a.name, mime: a.mime, dataBase64: a.dataUrl.slice(comma + 1) }
}

/**
 * Prévias locais das imagens enviadas nesta sessão, por id da mensagem gravada.
 * O host guarda só o hash do blob; sem isso, a mensagem recarregada mostra um ícone no lugar.
 */
export const sentPreviews = new Map<string, string[]>()
