import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeTurn {
  status?: number // padrão 200
  errorBody?: unknown // corpo JSON quando status != 200
  chunks?: Record<string, unknown>[] // cada item vira `data: <json>`; termina com `data: [DONE]`
  /** Extra opcional: mantém a conexão aberta após os chunks (sem `[DONE]`) até o cliente desconectar. */
  hold?: boolean
}

export interface FakeRouter {
  url: string
  requests: any[] // eslint-disable-line @typescript-eslint/no-explicit-any
  close(): Promise<void>
}

export const chunk = {
  text: (t: string, model = 'fake/model'): Record<string, unknown> => ({
    model,
    choices: [{ index: 0, delta: { content: t } }]
  }),
  toolCall: (index: number, id: string, name: string, args: string): Record<string, unknown> => ({
    model: 'fake/model',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }]
        }
      }
    ]
  }),
  finish: (reason: string): Record<string, unknown> => ({
    model: 'fake/model',
    choices: [{ index: 0, delta: {}, finish_reason: reason }]
  }),
  usage: (p: number, c: number): Record<string, unknown> => ({
    model: 'fake/model',
    choices: [],
    usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c }
  })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (d: Buffer) => parts.push(d))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Alternativa à fila: decide o turno a partir do corpo do request. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FakeResponder = (body: any) => FakeTurn | undefined

export function startFakeRouter(
  turns: FakeTurn[] | FakeResponder,
  models?: unknown[]
): Promise<FakeRouter> {
  const respond = typeof turns === 'function' ? turns : null
  const queue = typeof turns === 'function' ? [] : [...turns]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requests: any[] = []

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'GET' && path === '/v1/models') {
        sendJson(res, 200, { object: 'list', data: models ?? [] })
        return
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const raw = await readBody(req)
        let body: unknown = raw
        try {
          body = JSON.parse(raw)
        } catch {
          // mantém texto cru
        }
        requests.push(body)
        const turn = respond ? respond(body) : queue.shift()
        if (!turn) {
          sendJson(res, 500, {
            error: { message: 'fakeRouter: sem mais turnos', type: 'server_error' }
          })
          return
        }
        const status = turn.status ?? 200
        if (status !== 200) {
          sendJson(res, status, turn.errorBody ?? { error: { message: `HTTP ${status}` } })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        for (const c of turn.chunks ?? []) res.write(`data: ${JSON.stringify(c)}\n\n`)
        if (turn.hold) return // o cliente encerra (abort) ou close() derruba a conexão
        res.end('data: [DONE]\n\n')
        return
      }
      sendJson(res, 404, { error: { message: 'not found' } })
    })().catch((e: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(e) } })
      else res.destroy()
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}
