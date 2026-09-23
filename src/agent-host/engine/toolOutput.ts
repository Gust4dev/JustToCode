import type { ToolCallRecord } from '@shared/domain'
import type { Tool } from '../tools/types'
import type { ModelClient } from '../model/types'

export const READ_TOOL_OUTPUT = 'read_tool_output'
const DEFAULT_READ_LIMIT = 40_000
const MAX_READ_LIMIT = 200_000

/** Corta saídas grandes: cabeça 60% + cauda 40% + aviso com o id para `read_tool_output`. */
export function capToolOutput(
  text: string,
  maxChars: number,
  toolCallId: string
): { content: string; truncated: boolean } {
  const max = Math.max(0, Math.floor(maxChars))
  if (text.length <= max) return { content: text, truncated: false }
  const head = Math.floor(max * 0.6)
  const tail = max - head
  const omitted = text.length - head - tail
  const notice =
    `\n\n[... ${omitted} characters omitted (total ${text.length}). ` +
    `Call ${READ_TOOL_OUTPUT} with {"id": "${toolCallId}"} to read the full output ...]\n\n`
  return {
    content: text.slice(0, head) + notice + (tail > 0 ? text.slice(text.length - tail) : ''),
    truncated: true
  }
}

/** Máximo de caracteres da saída original enviados ao modelo que resume. */
const SUMMARY_INPUT_MAX_CHARS = 200_000

const TOOL_SUMMARY_SYSTEM = `You summarize the output of a tool call made by a coding agent.
Write a faithful summary of at most ~1500 words that the agent can use instead of the full output.
Preserve verbatim: error messages, file paths, line numbers, identifiers, commands, numbers and counts.
Keep the structure (sections, lists) when useful. Do not invent anything. Answer only with the summary.`

export function toolSummaryHeader(toolCallId: string): string {
  return `[Tool output summarized — full output: ${READ_TOOL_OUTPUT}("${toolCallId}")]\n`
}

/**
 * Resume uma saída longa de ferramenta tentando cada modelo em ordem (sem tools).
 * Devolve o conteúdo final (cabeçalho + resumo); lança se todos falharem.
 */
export async function summarizeToolOutput(
  model: ModelClient,
  p: { toolName: string; toolCallId: string; output: string; models: string[]; signal: AbortSignal }
): Promise<string> {
  const input = capToolOutput(p.output, SUMMARY_INPUT_MAX_CHARS, p.toolCallId).content
  const errors: string[] = []
  for (const m of p.models) {
    if (p.signal.aborted) break
    try {
      let text = ''
      for await (const ev of model.stream(
        {
          model: m,
          messages: [
            { role: 'system', content: TOOL_SUMMARY_SYSTEM },
            {
              role: 'user',
              content: `<tool name="${p.toolName}">\n${input}\n</tool>\n\nSummarize this tool output.`
            }
          ],
          tools: []
        },
        p.signal
      )) {
        if (ev.type === 'text_delta') text += ev.delta
      }
      text = text.trim()
      if (!text) {
        errors.push(`${m}: resposta vazia`)
        continue
      }
      return toolSummaryHeader(p.toolCallId) + text
    } catch (e) {
      errors.push(`${m}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new Error(errors.length ? errors.join('; ') : 'Nenhum modelo para resumir')
}

interface ToolCallLookup {
  get(id: string): (ToolCallRecord & { outputBlobHash: string | null }) | null
  listByChat(chatId: string): ToolCallRecord[]
}

interface ReadArgs {
  id: string
  offset?: number
  limit?: number
}

/** Ferramenta `read_tool_output`: lê a saída completa (blob) de uma tool call do mesmo chat. */
export function createReadToolOutputTool(toolCalls: ToolCallLookup): Tool<ReadArgs> {
  return {
    name: READ_TOOL_OUTPUT,
    kind: 'read',
    description:
      'Read the full output of a previous tool call whose output was truncated. ' +
      'Pass the id shown in the truncation notice (or the tool call id). ' +
      `Use offset/limit (in characters, default limit ${DEFAULT_READ_LIMIT}) to page through large outputs.`,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Tool call id from the truncation notice.' },
        offset: { type: 'integer', description: 'Character offset to start from (default 0).' },
        limit: {
          type: 'integer',
          description: `Maximum characters to return (default ${DEFAULT_READ_LIMIT}, max ${MAX_READ_LIMIT}).`
        }
      },
      required: ['id'],
      additionalProperties: false
    },
    summarize: (a) => `read output ${String(a?.id ?? '')}`,
    async run(args, ctx) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (!id) return { content: 'Missing required parameter: id', isError: true }
      let rec = toolCalls.get(id)
      if (!rec || rec.chatId !== ctx.chatId) {
        const byModelId = toolCalls
          .listByChat(ctx.chatId)
          .filter((t) => t.modelCallId === id)
          .pop()
        rec = byModelId ? toolCalls.get(byModelId.id) : null
      }
      if (!rec || rec.chatId !== ctx.chatId) {
        return { content: `No tool call found with id ${id}`, isError: true }
      }
      const blob = rec.outputBlobHash ? ctx.blobs.get(rec.outputBlobHash) : null
      const text = blob ? blob.toString('utf8') : (rec.outputPreview ?? '')
      const offset = Math.max(0, Math.floor(args.offset ?? 0))
      const limit = Math.min(
        MAX_READ_LIMIT,
        Math.max(1, Math.floor(args.limit ?? DEFAULT_READ_LIMIT))
      )
      if (offset === 0 && text.length <= limit) return { content: text }
      const end = Math.min(text.length, offset + limit)
      const part = text.slice(offset, end)
      const more = end < text.length ? ` Use offset ${end} to read more.` : ''
      return { content: `${part}\n[characters ${offset}-${end} of ${text.length}.${more}]` }
    }
  }
}
