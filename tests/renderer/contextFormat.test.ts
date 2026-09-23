import { describe, it, expect } from 'vitest'
import { formatTokens, meterColor } from '../../src/renderer/src/features/context/format'

describe('formatTokens', () => {
  it('mantém números abaixo de mil', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('abrevia milhares com k', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(61234)).toBe('61k')
    expect(formatTokens(128000)).toBe('128k')
    expect(formatTokens(999_999)).toBe('1M')
  })

  it('abrevia milhões com M', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(12_000_000)).toBe('12M')
  })

  it('valor inválido vira ?', () => {
    expect(formatTokens(Number.NaN)).toBe('?')
    expect(formatTokens(-1)).toBe('?')
  })
})

describe('meterColor', () => {
  it('verde abaixo de 50%', () => {
    expect(meterColor(0)).toBe('green')
    expect(meterColor(0.49)).toBe('green')
  })

  it('âmbar de 50% a menos de 70%', () => {
    expect(meterColor(0.5)).toBe('amber')
    expect(meterColor(0.69)).toBe('amber')
  })

  it('vermelha a partir de 70%', () => {
    expect(meterColor(0.7)).toBe('red')
    expect(meterColor(1)).toBe('red')
  })
})
