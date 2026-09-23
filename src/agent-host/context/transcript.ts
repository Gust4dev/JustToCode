import type { StoredMessage } from '@shared/domain'

const cap = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) + '…[truncated]' : s

/** Transcrição em texto plano para o summarizer. Summaries são ignorados (vão como "previous"). */
export function toTranscript(msgs: StoredMessage[], maxToolChars = 2000): string {
  const lines: string[] = []
  for (const sm of msgs) {
    if (sm.kind === 'summary') continue
    const m = sm.message
    switch (m.role) {
      case 'system':
        lines.push(`SYSTEM: ${m.content}`)
        break
      case 'user': {
        const text =
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
        lines.push(`USER: ${text}`)
        break
      }
      case 'assistant':
        if (m.content) lines.push(`ASSISTANT: ${m.content}`)
        for (const c of m.tool_calls ?? [])
          lines.push(`ASSISTANT → tool ${c.function.name}(${c.function.arguments})`)
        break
      case 'tool':
        lines.push(`TOOL RESULT (${m.tool_call_id}): ${cap(m.content, maxToolChars)}`)
        break
    }
  }
  return lines.join('\n\n')
}
