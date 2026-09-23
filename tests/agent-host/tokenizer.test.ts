import { describe, it, expect } from 'vitest'
import {
  IMAGE_TOKENS,
  estimateMessage,
  estimateMessages,
  estimateText
} from '../../src/agent-host/context/tokenizer'

const sample =
  'The quick brown fox jumps over the lazy dog. This sentence is used to test the tokenizer, ' +
  'and it should produce a number of tokens close to one quarter of its character length.'

describe('tokenizer', () => {
  it('texto vazio = 0', () => {
    expect(estimateText('')).toBe(0)
  })

  it('texto conhecido dentro de ±20% de length/4', () => {
    const n = estimateText(sample)
    const ref = sample.length / 4
    expect(n).toBeGreaterThanOrEqual(ref * 0.8)
    expect(n).toBeLessThanOrEqual(ref * 1.2)
  })

  it('tokens especiais não lançam', () => {
    expect(estimateText('<|endoftext|>')).toBeGreaterThan(0)
  })

  it('imagem = IMAGE_TOKENS (1600)', () => {
    expect(IMAGE_TOKENS).toBe(1600)
    const withImg = estimateMessage({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'blob:abc' } }]
    })
    const empty = estimateMessage({ role: 'user', content: '' })
    expect(withImg - empty).toBe(1600)
  })

  it('mensagem = ceil((texto + 4) × 1.10)', () => {
    const t = estimateText(sample)
    expect(estimateMessage({ role: 'user', content: sample })).toBe(Math.ceil((t + 4) * 1.1))
  })

  it('estimateMessages soma as mensagens', () => {
    const ms = [
      { role: 'system' as const, content: 'sys' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          { id: '1', type: 'function' as const, function: { name: 'grep', arguments: '{}' } }
        ]
      },
      { role: 'tool' as const, tool_call_id: '1', content: 'ok' }
    ]
    expect(estimateMessages(ms)).toBe(ms.reduce((a, m) => a + estimateMessage(m), 0))
    expect(estimateMessages([])).toBe(0)
  })
})
