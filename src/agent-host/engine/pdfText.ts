import { MAX_PDF_TEXT_CHARS } from '@shared/attachmentKinds'

/**
 * Texto de um PDF via pdfjs-dist (build legacy, Node). Import dinâmico: o pacote é ESM e fica
 * externo ao bundle (dependência em `node_modules`). Corta em `MAX_PDF_TEXT_CHARS`.
 */
export async function extractPdfText(buf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0
  })
  try {
    const doc = await task.promise
    const pages: string[] = []
    let total = 0
    for (let n = 1; n <= doc.numPages && total < MAX_PDF_TEXT_CHARS; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const text = content.items
        .map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim()
      pages.push(text)
      total += text.length
    }
    let out = pages.join('\n\n')
    if (out.length > MAX_PDF_TEXT_CHARS)
      out = out.slice(0, MAX_PDF_TEXT_CHARS) + '\n[texto truncado]'
    return out
  } finally {
    await task.destroy()
  }
}
