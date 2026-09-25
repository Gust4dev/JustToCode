import { APIConnectionError, APIError } from 'openai'

export interface ModelErrorInfo {
  status?: number
  code?: string
  retryable: boolean
  isContextLength: boolean
  isAuth: boolean
  /** Modelo descontinuado/inexistente no provider (410, ou 404 com texto de modelo inexistente). */
  isModelGone?: boolean
  /** Id do modelo citado na mensagem (entre aspas, após "model"), quando `isModelGone`. */
  goneModel?: string
}

export class ModelError extends Error {
  constructor(
    message: string,
    public o: ModelErrorInfo
  ) {
    super(message)
    this.name = 'ModelError'
  }
}

const CONTEXT_PATTERNS = [
  'context_length_exceeded',
  'maximum context',
  'context length',
  'prompt is too long',
  'too many tokens'
]

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
])

function isContextText(...parts: (string | undefined | null)[]): boolean {
  const text = parts.filter(Boolean).join(' ').toLowerCase()
  return CONTEXT_PATTERNS.some((p) => text.includes(p))
}

const GONE_PATTERNS = [
  'model not found',
  'does not exist',
  'end of life',
  'no longer available',
  'model_not_found'
]

function isGoneText(text: string): boolean {
  const t = text.toLowerCase()
  return GONE_PATTERNS.some((p) => t.includes(p))
}

/** Id entre aspas simples/duplas logo após "model" (`The model 'x/y' has...` → `x/y`). */
export function extractGoneModel(text: string): string | undefined {
  const m = /model['"]?\s*[:=]?\s*['"`]([\w.@-][^'"`\s]*)['"`]/i.exec(text)
  return m?.[1]
}

function errorCode(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined
  const c = (e as { code?: unknown }).code
  if (typeof c === 'string') return c
  const cause = (e as { cause?: unknown }).cause
  return cause && cause !== e ? errorCode(cause) : undefined
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

export function toModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e

  if (e instanceof APIConnectionError) {
    return new ModelError(e.message || 'Falha de conexão com o router', {
      code: errorCode(e),
      retryable: true,
      isContextLength: false,
      isAuth: false
    })
  }

  if (e instanceof APIError) {
    const status = typeof e.status === 'number' ? e.status : undefined
    const body = e.error as { code?: unknown; type?: unknown; message?: unknown } | undefined
    const code =
      (typeof e.code === 'string' && e.code) ||
      (typeof body?.code === 'string' && body.code) ||
      (typeof body?.type === 'string' && body.type) ||
      undefined
    const message = e.message || `Erro HTTP ${status ?? '?'}`
    const isAuth = status === 401 || code === 'invalid_api_key'
    const isContextLength = isContextText(message, code, safeJson(e.error))
    const raw = safeJson(e.error)
    const isModelGone =
      !isAuth && (status === 410 || (status === 404 && isGoneText(`${message} ${raw}`)))
    const retryable =
      !isAuth &&
      !isContextLength &&
      !isModelGone &&
      (status === 429 || (status !== undefined && status >= 500))
    const info: ModelErrorInfo = { status, code, retryable, isContextLength, isAuth }
    if (isModelGone) {
      info.isModelGone = true
      const goneModel = extractGoneModel(message) ?? extractGoneModel(raw)
      if (goneModel) info.goneModel = goneModel
    }
    return new ModelError(message, info)
  }

  const message = e instanceof Error ? e.message : String(e)
  const code = errorCode(e)
  const network =
    (code !== undefined && NETWORK_CODES.has(code)) ||
    (e instanceof TypeError && /fetch failed|network/i.test(message))
  return new ModelError(message, {
    code,
    retryable: network,
    isContextLength: isContextText(message, code),
    isAuth: code === 'invalid_api_key'
  })
}
