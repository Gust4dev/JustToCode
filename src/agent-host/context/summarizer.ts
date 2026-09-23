import type { ChatMessage, StoredMessage } from '@shared/domain'
import type { ModelClient } from '../model/types'
import { toTranscript } from './transcript'

export const SUMMARY_SECTIONS = [
  '## Goal',
  '## Decisions',
  '## Files and facts',
  '## Done',
  '## Pending'
]

const SYSTEM = `You compress a coding-agent conversation into a structured summary that replaces the original messages.
The agent will continue the work using ONLY your summary plus the most recent messages, so keep every fact needed to continue.
Output markdown with exactly these sections, in this order:
${SUMMARY_SECTIONS.join('\n')}
Rules:
- Goal: what the user wants overall and the current sub-goal.
- Decisions: choices made and why, constraints the user stated.
- Files and facts: file paths, symbols, commands, error messages, numbers and results worth remembering.
- Done: what was completed.
- Pending: what is left, open questions, next step.
- If a previous summary is given, merge it with the new messages: keep what is still true, update what changed, drop nothing important.
- Be concise and factual. Do not invent anything. Write in English, but keep code, paths and quoted text verbatim.`

export function buildSummaryPrompt(previous: string | null, transcript: string): ChatMessage[] {
  const parts: string[] = []
  if (previous) parts.push(`<previous_summary>\n${previous}\n</previous_summary>`)
  parts.push(`<conversation>\n${transcript}\n</conversation>`)
  parts.push(
    previous
      ? 'Update the previous summary with the conversation above. Answer only with the summary.'
      : 'Summarize the conversation above. Answer only with the summary.'
  )
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: parts.join('\n\n') }
  ]
}

export interface Summarizer {
  summarize(p: {
    previous: string | null
    messages: StoredMessage[]
    models: string[]
    signal?: AbortSignal
  }): Promise<{ text: string; model: string }>
}

const hasSections = (text: string): boolean => SUMMARY_SECTIONS.every((s) => text.includes(s))

export function createSummarizer(model: ModelClient): Summarizer {
  return {
    async summarize({ previous, messages, models, signal }) {
      const prompt = buildSummaryPrompt(previous, toTranscript(messages))
      const errors: string[] = []
      for (const m of models) {
        if (signal?.aborted) throw new Error('Compactação cancelada')
        try {
          let text = ''
          const stream = model.stream(
            { model: m, messages: prompt, tools: [] },
            signal ?? new AbortController().signal
          )
          for await (const ev of stream) if (ev.type === 'text_delta') text += ev.delta
          text = text.trim()
          if (!hasSections(text)) {
            errors.push(`${m}: resposta sem as seções do resumo`)
            continue
          }
          return { text, model: m }
        } catch (e) {
          if (signal?.aborted) throw e
          errors.push(`${m}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      throw new Error(
        models.length === 0
          ? 'Nenhum modelo configurado para resumir'
          : `Falha ao resumir: ${errors.join('; ')}`
      )
    }
  }
}
