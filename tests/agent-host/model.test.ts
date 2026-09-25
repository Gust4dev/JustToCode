import { describe, it, expect, afterEach } from 'vitest'
import { APIError } from 'openai'
import { startFakeRouter, chunk, type FakeRouter, type FakeTurn } from '../helpers/fakeRouter'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { ModelError, toModelError } from '../../src/agent-host/model/errors'
import { parseModels } from '../../src/agent-host/model/models'
import type { ChatRequest, ModelClient, ModelEvent } from '../../src/agent-host/model/types'
import { DEFAULT_CONFIG, type AppConfig } from '../../src/shared/domain'

let router: FakeRouter | null = null
afterEach(async () => {
  await router?.close()
  router = null
})

async function setup(turns: FakeTurn[], models?: unknown[]): Promise<ModelClient> {
  router = await startFakeRouter(turns, models)
  const cfg: AppConfig = { ...DEFAULT_CONFIG, routerBaseUrl: router.url, routerApiKey: 'sk-test' }
  return createOpenAiClient(() => cfg)
}

const req: ChatRequest = {
  model: 'dev-combo',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'oi' }
  ],
  tools: []
}

async function collect(
  client: ModelClient,
  signal = new AbortController().signal
): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []
  for await (const e of client.stream(req, signal)) out.push(e)
  return out
}

async function catchErr(p: Promise<unknown>): Promise<ModelError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ModelError)
    return e as ModelError
  }
  throw new Error('esperava erro')
}

describe('openaiClient.stream', () => {
  it('texto em streaming, model_reported uma vez, usage e done', async () => {
    const client = await setup([
      {
        chunks: [
          chunk.text('Olá', 'prov/real-model'),
          chunk.text(', mundo'),
          chunk.finish('stop'),
          chunk.usage(12, 3)
        ]
      }
    ])
    const events = await collect(client)
    expect(events.filter((e) => e.type === 'model_reported')).toEqual([
      { type: 'model_reported', model: 'prov/real-model' }
    ])
    const text = events
      .filter((e): e is Extract<ModelEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('')
    expect(text).toBe('Olá, mundo')
    expect(events).toContainEqual({ type: 'usage', promptTokens: 12, completionTokens: 3 })
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' })

    const body = router!.requests[0]
    expect(body.model).toBe('dev-combo')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.messages).toHaveLength(2)
  })

  it('duas tool calls paralelas com argumentos quebrados em deltas', async () => {
    const client = await setup([
      {
        chunks: [
          chunk.toolCall(0, 'call_a', 'read_file', '{"pa'),
          chunk.toolCall(1, 'call_b', 'grep', '{"pat'),
          {
            model: 'fake/model',
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }
              }
            ]
          },
          {
            model: 'fake/model',
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 1, function: { arguments: 'tern":"x"}' } }] }
              }
            ]
          },
          chunk.finish('tool_calls'),
          chunk.usage(5, 7)
        ]
      }
    ])
    const events = await collect(client)
    const tc = events.filter((e) => e.type === 'tool_calls')
    expect(tc).toHaveLength(1)
    expect(tc[0]).toEqual({
      type: 'tool_calls',
      calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
        },
        { id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }
      ]
    })
    const idxTool = events.findIndex((e) => e.type === 'tool_calls')
    const idxDone = events.findIndex((e) => e.type === 'done')
    expect(idxTool).toBeLessThan(idxDone)
    expect(events[idxDone]).toEqual({ type: 'done', finishReason: 'tool_calls' })
  })

  it('reasoning_delta a partir de reasoning_content ou reasoning', async () => {
    const client = await setup([
      {
        chunks: [
          { model: 'm', choices: [{ index: 0, delta: { reasoning_content: 'pensa ' } }] },
          { model: 'm', choices: [{ index: 0, delta: { reasoning: 'mais' } }] },
          chunk.finish('stop')
        ]
      }
    ])
    const events = await collect(client)
    expect(events.filter((e) => e.type === 'reasoning_delta')).toEqual([
      { type: 'reasoning_delta', delta: 'pensa ' },
      { type: 'reasoning_delta', delta: 'mais' }
    ])
  })

  it('401 → isAuth', async () => {
    const client = await setup([
      { status: 401, errorBody: { error: { message: 'bad key', code: 'invalid_api_key' } } }
    ])
    const err = await catchErr(collect(client))
    expect(err.o).toMatchObject({ status: 401, isAuth: true, retryable: false })
  })

  it('400 com context_length_exceeded → isContextLength', async () => {
    const client = await setup([
      {
        status: 400,
        errorBody: {
          error: { message: 'This request exceeds the limit', code: 'context_length_exceeded' }
        }
      }
    ])
    const err = await catchErr(collect(client))
    expect(err.o).toMatchObject({
      status: 400,
      isContextLength: true,
      retryable: false,
      isAuth: false
    })
  })

  it('503 → retryable', async () => {
    const client = await setup([{ status: 503, errorBody: { error: { message: 'busy' } } }])
    const err = await catchErr(collect(client))
    expect(err.o).toMatchObject({ status: 503, retryable: true })
    expect(router!.requests).toHaveLength(1) // sem retry interno do SDK
  })

  it('erro de rede → retryable', async () => {
    const r = await startFakeRouter([])
    const url = r.url
    await r.close()
    const client = createOpenAiClient(() => ({ ...DEFAULT_CONFIG, routerBaseUrl: url }))
    const err = await catchErr(collect(client))
    expect(err.o.retryable).toBe(true)
  })

  it('abort no meio do stream encerra sem erro', async () => {
    const client = await setup([{ chunks: [chunk.text('parcial')], hold: true }])
    const ac = new AbortController()
    const events: ModelEvent[] = []
    for await (const e of client.stream(req, ac.signal)) {
      events.push(e)
      if (e.type === 'text_delta') ac.abort()
    }
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })

  it('recria o cliente quando a config muda', async () => {
    router = await startFakeRouter([{ chunks: [chunk.text('a'), chunk.finish('stop')] }])
    const other = await startFakeRouter([{ chunks: [chunk.text('b'), chunk.finish('stop')] }])
    let cfg: AppConfig = { ...DEFAULT_CONFIG, routerBaseUrl: router.url }
    const client = createOpenAiClient(() => cfg)
    await collect(client)
    cfg = { ...cfg, routerBaseUrl: other.url }
    await collect(client)
    expect(router.requests).toHaveLength(1)
    expect(other.requests).toHaveLength(1)
    await other.close()
  })
})

describe('models', () => {
  it('listModels usa GET /models e parseModels', async () => {
    const client = await setup(
      [],
      [
        { id: 'dev-combo', object: 'model', owned_by: 'combo' },
        {
          id: 'prov/gpt',
          owned_by: 'prov',
          capabilities: { contextWindow: 128000, vision: true, tools: true },
          max_completion_tokens: 16000
        }
      ]
    )
    const list = await client.listModels()
    expect(list).toEqual([
      {
        id: 'dev-combo',
        ownedBy: 'combo',
        isCombo: true,
        contextWindow: null,
        maxOutput: null,
        vision: false,
        tools: false
      },
      {
        id: 'prov/gpt',
        ownedBy: 'prov',
        isCombo: false,
        contextWindow: 128000,
        maxOutput: 16000,
        vision: true,
        tools: true
      }
    ])
  })

  it('parseModels aceita context_length e ignora itens inválidos', () => {
    expect(
      parseModels({ data: [{ id: 'x', owned_by: 'y', context_length: 32000 }, { foo: 1 }, null] })
    ).toEqual([
      {
        id: 'x',
        ownedBy: 'y',
        isCombo: false,
        contextWindow: 32000,
        maxOutput: null,
        vision: false,
        tools: false
      }
    ])
    expect(parseModels('lixo')).toEqual([])
  })
})

describe('toModelError', () => {
  it('mensagem com "maximum context" → isContextLength', () => {
    expect(
      toModelError(new Error("This model's maximum context length is 8192")).o.isContextLength
    ).toBe(true)
  })
  it('ECONNREFUSED → retryable', () => {
    const e = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })
    expect(toModelError(e).o.retryable).toBe(true)
  })

  const GONE_BODY = {
    type: 'about:blank',
    title: 'Gone',
    status: 410,
    detail:
      "The model 'minimaxai/minimax-m3' has reached its end of life on 2026-09-09T09:00:00Z and is no longer available."
  }
  it('410 do 9router (corpo real) → isModelGone + goneModel, não retryable', () => {
    // O client do SDK embrulha corpos sem `error` em `{ error: corpo }` antes do generate.
    const e = toModelError(APIError.generate(410, { error: GONE_BODY }, undefined, new Headers()))
    expect(e.o).toMatchObject({
      status: 410,
      isModelGone: true,
      goneModel: 'minimaxai/minimax-m3',
      retryable: false,
      isAuth: false,
      isContextLength: false
    })
  })
  it('404 "model not found" → isModelGone', () => {
    const e = toModelError(
      APIError.generate(
        404,
        { error: { message: 'The model "cx/gpt-9" does not exist', code: 'model_not_found' } },
        undefined,
        new Headers()
      )
    )
    expect(e.o.isModelGone).toBe(true)
    expect(e.o.goneModel).toBe('cx/gpt-9')
    expect(e.o.retryable).toBe(false)
    expect(e.o.code).toBe('model_not_found')
  })
  it('404 genérico e 500 não são isModelGone', () => {
    const nf = toModelError(
      APIError.generate(404, { error: { message: 'route missing' } }, undefined, new Headers())
    )
    expect(nf.o.isModelGone).toBeUndefined()
    const s5 = toModelError(
      APIError.generate(500, { error: { message: 'boom' } }, undefined, new Headers())
    )
    expect(s5.o.isModelGone).toBeUndefined()
    expect(s5.o.retryable).toBe(true)
  })
})
