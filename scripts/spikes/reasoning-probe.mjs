// Spike: reasoning via 9router — `reasoning_effort` (param) × sufixo `modelo(level)` × ambos.
// Node >= 22, sem dependências. NÃO é executado pelos agentes; rode você mesmo:
//   $env:NR_KEY = '<chave do 9router>'; node scripts/spikes/reasoning-probe.mjs > $env:TEMP/reasoning-probe.json
// Env: NR_BASE (padrão http://localhost:20128/v1), NR_KEY (obrigatória), NR_MODELS (ids separados por
//   vírgula), NR_LEVELS (padrão low,high), NR_STYLES (padrão none,param,suffix,both).
// Para cada modelo × estilo × nível, registra status, modelo reportado, se veio reasoning no stream,
// `usage.completion_tokens_details.reasoning_tokens` e o total de completion tokens.
// "Confirmado" = reasoning no stream OU reasoning_tokens > 0 (mesma regra do app).
const BASE = process.env.NR_BASE ?? 'http://localhost:20128/v1'
const KEY = process.env.NR_KEY
const MODELS = (
  process.env.NR_MODELS ??
  'cc/claude-sonnet-5,cx/gpt-5.6-luna,gemini/gemini-3.7-flash,ag/gpt-oss-120b-medium'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const LEVELS = (process.env.NR_LEVELS ?? 'low,high').split(',').map((s) => s.trim())
const STYLES = (process.env.NR_STYLES ?? 'none,param,suffix,both').split(',').map((s) => s.trim())

if (!KEY) {
  console.error('Defina NR_KEY com a chave do 9router.')
  process.exit(1)
}

const headers = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }
const PROMPT =
  'A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. ' +
  'How much does the ball cost? Think it through, then answer with just the number.'

function bodyFor(model, style, level) {
  const body = {
    model: style === 'suffix' || style === 'both' ? `${model}(${level})` : model,
    messages: [{ role: 'user', content: PROMPT }],
    stream: true,
    stream_options: { include_usage: true }
  }
  if (style === 'param' || style === 'both') body.reasoning_effort = level
  return body
}

async function probe(model, style, level) {
  const body = bodyFor(model, style, level)
  const started = Date.now()
  const out = {
    model,
    style,
    level: style === 'none' ? null : level,
    sentModel: body.model,
    reasoningEffort: body.reasoning_effort ?? null,
    status: 0,
    reported: null,
    reasoningChars: 0,
    reasoningTokens: null,
    completionTokens: null,
    textChars: 0,
    confirmed: false,
    ms: 0,
    error: null
  }
  let res
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
  } catch (e) {
    out.error = String(e?.cause ?? e)
    return out
  }
  out.status = res.status
  if (!res.ok) {
    out.error = (await res.text()).slice(0, 1000)
    out.ms = Date.now() - started
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
          continue
        }
        if (j.error) out.error = JSON.stringify(j.error).slice(0, 1000)
        if (!out.reported && typeof j.model === 'string') out.reported = j.model
        for (const c of j.choices ?? []) {
          const d = c.delta ?? {}
          const r = d.reasoning_content ?? d.reasoning
          if (typeof r === 'string') out.reasoningChars += r.length
          if (typeof d.content === 'string') out.textChars += d.content.length
        }
        if (j.usage) {
          out.completionTokens = j.usage.completion_tokens ?? null
          const rt = j.usage.completion_tokens_details?.reasoning_tokens
          if (typeof rt === 'number') out.reasoningTokens = rt
        }
      }
    }
  } catch (e) {
    out.error = String(e)
  }
  out.confirmed = out.reasoningChars > 0 || (out.reasoningTokens ?? 0) > 0
  out.ms = Date.now() - started
  return out
}

const results = []
for (const model of MODELS) {
  for (const style of STYLES) {
    const levels = style === 'none' ? [LEVELS[0]] : LEVELS
    for (const level of levels) {
      const r = await probe(model, style, level)
      console.error(
        `${model} ${style}${r.level ? `/${r.level}` : ''}: HTTP ${r.status} ` +
          `confirmed=${r.confirmed} rt=${r.reasoningTokens} rc=${r.reasoningChars} ${r.error ?? ''}`
      )
      results.push(r)
    }
  }
}

// Resumo por modelo: qual estilo confirmou reasoning.
const summary = {}
for (const r of results) {
  summary[r.model] ??= {}
  if (r.style === 'none') continue
  summary[r.model][`${r.style}/${r.level}`] = r.status === 200 ? r.confirmed : `HTTP ${r.status}`
}

console.log(JSON.stringify({ base: BASE, at: new Date().toISOString(), summary, results }, null, 2))
