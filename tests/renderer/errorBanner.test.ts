import { describe, it, expect } from 'vitest'
import { errorAction, splitInlineCode } from '../../src/renderer/src/features/chat/errorBanner'
import { applyEngineEvent, initialChatState } from '../../src/renderer/src/features/chat/chatStore'

const GONE =
  'O modelo `minimaxai/minimax-m3` da combo `fake/combo` foi descontinuado pelo provider. Remova-o da combo no dashboard do 9router ou troque a combo do chat.'

describe('banner de erro do turno', () => {
  it('turn_error MODEL_GONE vira lastError com o code', () => {
    const s = applyEngineEvent(
      initialChatState(),
      { type: 'turn_error', chatId: 'c', message: GONE, code: 'MODEL_GONE' },
      'c'
    )
    expect(s.lastError).toEqual({ message: GONE, code: 'MODEL_GONE' })
  })

  it('ação por code: MODEL_GONE → dashboard do 9router; AUTH → configurações', () => {
    expect(errorAction('MODEL_GONE')).toBe('router-dashboard')
    expect(errorAction('AUTH')).toBe('settings')
    expect(errorAction('MODEL_ERROR')).toBeNull()
    expect(errorAction(undefined)).toBeNull()
  })

  it('trechos entre crases viram código inline', () => {
    expect(splitInlineCode(GONE)).toEqual([
      { text: 'O modelo ', code: false },
      { text: 'minimaxai/minimax-m3', code: true },
      { text: ' da combo ', code: false },
      { text: 'fake/combo', code: true },
      {
        text: ' foi descontinuado pelo provider. Remova-o da combo no dashboard do 9router ou troque a combo do chat.',
        code: false
      }
    ])
    expect(splitInlineCode('sem código')).toEqual([{ text: 'sem código', code: false }])
  })
})
