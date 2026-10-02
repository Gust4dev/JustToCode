import { describe, expect, it } from 'vitest'
import type { AttachmentMeta, ContentPart } from '../../src/shared/domain'
import {
  classifyAttachment,
  decodeText,
  fileBlock,
  pdfTextHeader,
  rejectReason
} from '../../src/shared/attachmentKinds'
import { sentDelivery, userTextOf } from '../../src/renderer/src/features/chat/attachments'

describe('anexos', () => {
  it('classifica por mime/extensão e aplica limites', () => {
    expect(classifyAttachment('a.png', 'image/png')).toBe('image')
    expect(classifyAttachment('Dockerfile', '')).toBe('text')
    expect(classifyAttachment('x.ts', 'video/mp2t')).toBe('text')
    expect(classifyAttachment('doc.pdf', '')).toBe('pdf')
    expect(classifyAttachment('app.exe', 'application/x-msdownload')).toBe('unsupported')
    expect(rejectReason('text', 300 * 1024)).toMatch(/200 KB/)
    expect(rejectReason('pdf', 5 * 1024 * 1024)).toBeNull()
  })

  it('decodifica texto, recusa binário e monta o bloco cercado', () => {
    expect(decodeText(new Uint8Array([0x61, 0x00, 0x62]))).toBeNull()
    expect(decodeText(new TextEncoder().encode('olá'))).toBe('olá')
    expect(fileBlock('a.md', 'x\n```\ny')).toBe('````markdown a.md\nx\n```\ny\n````')
  })

  it('balão: separa o texto do usuário e diz como cada arquivo foi enviado', () => {
    const meta = (name: string): AttachmentMeta => ({
      id: name,
      kind: 'file',
      name,
      blobHash: 'h',
      mime: '',
      bytes: 1,
      width: null,
      height: null
    })
    const content: ContentPart[] = [
      { type: 'text', text: 'veja' },
      { type: 'text', text: fileBlock('a.ts', 'let x') },
      { type: 'text', text: `${pdfTextHeader('b.pdf')}\ntexto` },
      { type: 'file', file: { filename: 'c.pdf', file_data: 'blob:h' } }
    ]
    const metas = [meta('a.ts'), meta('b.pdf'), meta('c.pdf')]
    expect(userTextOf(content, metas)).toBe('veja')
    expect(metas.map((m) => sentDelivery(content, m))).toEqual([
      'texto',
      'PDF como texto',
      'PDF nativo'
    ])
  })
})
