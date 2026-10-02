/** Classificação de anexos (renderer e agent-host): o que entra, com que limite e como vai ao modelo. */

export type AttachmentClass = 'image' | 'text' | 'pdf' | 'unsupported'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_TEXT_BYTES = 200 * 1024
export const MAX_PDF_BYTES = 20 * 1024 * 1024
/** Texto extraído de PDF que vai no request (caracteres). */
export const MAX_PDF_TEXT_CHARS = 200_000

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/x-javascript',
  'application/sql',
  'application/x-sh'
])

/** Extensão conhecida → linguagem da cerca de código. */
const TEXT_EXTS: Record<string, string> = {
  md: 'markdown',
  txt: 'text',
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  env: 'dotenv',
  csv: 'csv',
  tsv: 'tsv',
  log: 'text',
  html: 'html',
  css: 'css',
  scss: 'scss',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  php: 'php',
  sh: 'bash',
  ps1: 'powershell',
  bat: 'bat',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  gitignore: 'gitignore',
  dockerfile: 'dockerfile',
  prisma: 'prisma',
  graphql: 'graphql',
  vue: 'vue',
  svelte: 'svelte'
}

/** Extensão em minúsculas (`.gitignore` → `gitignore`, `Dockerfile` → `dockerfile`, `.env.local` → `env`). */
export function extOf(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (base === '.env' || base.startsWith('.env.')) return 'env'
  const i = base.lastIndexOf('.')
  return i >= 0 ? base.slice(i + 1) : base
}

export function classifyAttachment(name: string, mime: string): AttachmentClass {
  const m = mime.toLowerCase()
  const ext = extOf(name)
  if (ext === 'svg') return 'text'
  if (m.startsWith('image/')) return 'image'
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (m.startsWith('text/') || TEXT_MIMES.has(m) || ext in TEXT_EXTS) return 'text'
  return 'unsupported'
}

export const fenceLang = (name: string): string => TEXT_EXTS[extOf(name)] ?? 'text'

export function maxBytesFor(cls: AttachmentClass): number {
  return cls === 'text' ? MAX_TEXT_BYTES : cls === 'unsupported' ? 0 : MAX_IMAGE_BYTES
}

/** Motivo da recusa (pt-BR) ou null se o anexo é aceito. */
export function rejectReason(cls: AttachmentClass, bytes: number): string | null {
  if (cls === 'unsupported') return 'tipo não suportado (só imagens, texto/código e PDF)'
  const max = maxBytesFor(cls)
  if (bytes > max) {
    const label = cls === 'text' ? 'arquivos de texto' : cls === 'pdf' ? 'PDFs' : 'imagens'
    return `passa do limite de ${max >= 1024 * 1024 ? `${max / (1024 * 1024)} MB` : `${max / 1024} KB`} para ${label}`
  }
  return null
}

/** UTF-8 → string; null se parece binário (NUL ou mais de 1% de bytes inválidos). */
export function decodeText(buf: Uint8Array): string | null {
  if (buf.includes(0)) return null
  const text = new TextDecoder('utf-8').decode(buf) // já remove o BOM
  let bad = 0
  for (const ch of text) if (ch.charCodeAt(0) === 0xfffd) bad++
  return bad > Math.max(2, text.length / 100) ? null : text
}

/** Bloco de código com o arquivo; a cerca cresce se o conteúdo já tiver crases. */
export function fileBlock(name: string, body: string): string {
  let fence = '```'
  while (body.includes(fence)) fence += '`'
  return `${fence}${fenceLang(name)} ${name}\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}`
}

export const PDF_TEXT_PREFIX = 'PDF: '
export const pdfTextHeader = (name: string): string => `${PDF_TEXT_PREFIX}${name} (texto extraído)`

/** Combo/modelo aceita PDF nativo: todos os membros não ignorados com `pdf`; desconhecido → false. */
export function supportsPdf(
  info: { isCombo: boolean; members: string[]; ignored: string[] } | null,
  model: string,
  models: { id: string; pdf?: boolean }[]
): boolean {
  const byId = new Map(models.map((m) => [m.id, m]))
  if (!info) return byId.get(model)?.pdf === true
  const active = info.isCombo ? info.members.filter((m) => !info.ignored.includes(m)) : [model]
  return active.length > 0 && active.every((m) => byId.get(m)?.pdf === true)
}
