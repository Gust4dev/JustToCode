import { APIConnectionError, APIError } from 'openai'

export interface ModelErrorInfo {
  status?: number
  code?: string
  retryable: boolean
  isContextLength: boolean
  isAuth: boolean
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
    const retryable =
      !isAuth && !isContextLength && (status === 429 || (status !== undefined && status >= 500))
    return new ModelError(message, { status, code, retryable, isContextLength, isAuth })
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
