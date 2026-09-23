// Spikes S1–S3 contra o 9router. Node >= 22, sem dependências.
// Uso: node scripts/spikes/9router-probe.mjs > $env:TEMP/9router-probe.json
// Env: NR_BASE, NR_KEY (chave do 9router; o chat devolve 401 sem ela), NR_COMBO, NR_MODELS (ids separados por vírgula; o 1º gera, o 2º continua no S3)
const BASE = process.env.NR_BASE ?? 'http://localhost:20128/v1'
const KEY = process.env.NR_KEY
const COMBO = process.env.NR_COMBO ?? 'dev-combo'
const MODELS = (
  process.env.NR_MODELS ??
  'cc/claude-sonnet-5,cx/gpt-5.6-luna,gemini/gemini-3.7-flash,ag/gpt-oss-120b-medium'
).split(',')
const headers = {
  'content-type': 'application/json',
  ...(KEY ? { authorization: `Bearer ${KEY}` } : {})
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lê um arquivo do projeto',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  }
]

async function stream(body) {
  const started = Date.now()
  let res
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } })
    })
  } catch (e) {
    return { status: 0, error: String(e?.cause ?? e) }
  }
  const out = {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    models: new Set(),
    usage: null,
    usageChunk: null,
    chunkCount: 0,
    finishReasons: [],
    text: '',
    toolCalls: {},
    raw: [],
    last: null,
    parseErrors: 0
  }
  if (!res.ok) {
    out.error = (await res.text()).slice(0, 2000)
    out.models = []
    return out
  }
  const dec = new TextDecoder()
  let buf = ''
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let j
        try {
          j = JSON.parse(data)
        } catch {
          out.parseErrors++
          continue
        }
        out.chunkCount++
        if (out.raw.length < 3) out.raw.push(j)
        out.last = j
        if (j.error) out.streamError = j.error
        if (j.model) out.models.add(j.model)
        if (j.usage) {
          out.usage = j.usage
          out.usageChunk = out.chunkCount
        }
        const c = j.choices?.[0]
        if (c?.finish_reason) out.finishReasons.push(c.finish_reason)
        const d = c?.delta
        if (d?.content) out.text += d.content
        for (const tc of d?.tool_calls ?? []) {
          const t = (out.toolCalls[tc.index ?? 0] ??= { id: '', name: '', args: '' })
          if (tc.id) t.id = tc.id
          if (tc.function?.name) t.name += tc.function.name
          if (tc.function?.arguments) t.args += tc.function.arguments
        }
      }
    }
  } catch (e) {
    out.streamError = String(e)
  }
  out.models = [...out.models]
  out.ms = Date.now() - started
  return out
}

const report = { base: BASE, combo: COMBO, models: MODELS }

// S1: a combo revela o membro real e o usage?
report.S1 = await stream({ model: COMBO, messages: [{ role: 'user', content: 'Responda só: ok' }] })
if (report.S1.status === 401) {
  console.error(
    `9router devolveu 401 (${KEY ? 'chave recusada' : 'sem chave'}): defina NR_KEY com a chave do 9router`
  )
  process.exit(1)
}

// S2: tool calling por família
const PROMPT = 'Use a ferramenta read_file para ler package.json e README.md (duas chamadas).'
report.S2 = {}
for (const m of MODELS) {
  report.S2[m] = await stream({ model: m, tools, messages: [{ role: 'user', content: PROMPT }] })
}

// S3: tool call gerada por A, continuação em B
const [A, B] = MODELS
const first = report.S2[A]
const calls = Object.values(first.toolCalls ?? {})
if (calls.length) {
  const history = [
    { role: 'user', content: PROMPT },
    {
      role: 'assistant',
      content: first.text || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args }
      }))
    },
    ...calls.map((c) => ({
      role: 'tool',
      tool_call_id: c.id,
      content: `conteúdo fictício de ${c.args}`
    }))
  ]
  report.S3 = {
    from: A,
    to: B,
    result: await stream({
      model: B,
      tools,
      messages: [...history, { role: 'user', content: 'Resuma o que leu em uma frase.' }]
    })
  }
} else {
  report.S3 = { skipped: `modelo ${A} não gerou tool calls` }
}

console.log(JSON.stringify(report, null, 2))
