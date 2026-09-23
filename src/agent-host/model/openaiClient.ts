import OpenAI, { APIUserAbortError } from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions'
import type { AppConfig, ChatMessage, ModelInfo, ToolCallSpec } from '@shared/domain'
import type { ChatRequest, ModelClient, ModelEvent } from './types'
import { toModelError } from './errors'
import { parseModels } from './models'

type ChunkDelta = ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: unknown
  reasoning?: unknown
}

/** Remove campos internos (ex.: `reasoning`) antes de mandar ao router. */
function toWireMessage(m: ChatMessage): ChatCompletionMessageParam {
  if (m.role === 'assistant') {
    const out: Record<string, unknown> = { role: 'assistant', content: m.content }
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls
    return out as unknown as ChatCompletionMessageParam
  }
  return m as unknown as ChatCompletionMessageParam
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    e instanceof APIUserAbortError ||
    (e instanceof Error && e.name === 'AbortError')
  )
}

export function createOpenAiClient(getConfig: () => AppConfig): ModelClient {
  let cached: { key: string; client: OpenAI } | null = null

  const client = (): OpenAI => {
    const cfg = getConfig()
    const apiKey = cfg.routerApiKey || 'sem-chave'
    const key = `${cfg.routerBaseUrl}\n${apiKey}`
    if (!cached || cached.key !== key) {
      cached = {
        key,
        client: new OpenAI({ baseURL: cfg.routerBaseUrl, apiKey, maxRetries: 0 })
      }
    }
    return cached.client
  }

  async function* stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    if (signal.aborted) return
    const tools = req.tools as ChatCompletionTool[]
    let iterable: AsyncIterable<ChatCompletionChunk>
    try {
      iterable = await client().chat.completions.create(
        {
          model: req.model,
          messages: req.messages.map(toWireMessage),
          ...(tools.length ? { tools } : {}),
          stream: true,
          stream_options: { include_usage: true }
        },
        { signal }
      )
    } catch (e) {
      if (isAbort(e, signal)) return
      throw toModelError(e)
    }

    const calls = new Map<number, ToolCallSpec>()
    let reported = false
    let finishReason: string | null = null
    try {
      for await (const chunk of iterable) {
        if (!reported && typeof chunk.model === 'string' && chunk.model) {
          reported = true
          yield { type: 'model_reported', model: chunk.model }
        }
        for (const choice of chunk.choices ?? []) {
          const delta = (choice.delta ?? {}) as ChunkDelta
          const reasoning = delta.reasoning_content ?? delta.reasoning
          if (typeof reasoning === 'string' && reasoning) {
            yield { type: 'reasoning_delta', delta: reasoning }
          }
          if (typeof delta.content === 'string' && delta.content) {
            yield { type: 'text_delta', delta: delta.content }
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = typeof tc.index === 'number' ? tc.index : calls.size
            let cur = calls.get(idx)
            if (!cur) {
              cur = { id: '', type: 'function', function: { name: '', arguments: '' } }
              calls.set(idx, cur)
            }
            if (tc.id) cur.id += tc.id
            if (tc.function?.name) cur.function.name += tc.function.name
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
          }
          if (choice.finish_reason) finishReason = choice.finish_reason
        }
        if (chunk.usage) {
          yield {
            type: 'usage',
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0
          }
        }
      }
    } catch (e) {
      if (isAbort(e, signal)) return
      throw toModelError(e)
    }
    if (signal.aborted) return

    if (calls.size) {
      const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
      yield { type: 'tool_calls', calls: ordered }
    }
    yield { type: 'done', finishReason }
  }

  async function listModels(): Promise<ModelInfo[]> {
    try {
      const json = await client().get<unknown>('/models')
      return parseModels(json)
    } catch (e) {
      throw toModelError(e)
    }
  }

  return { stream, listModels }
}
