import { describe, it, expect } from 'vitest'
import { reduceUpdate, normalizeNotes, type UpdateState } from '../../src/main/updater/state'

const idle: UpdateState = { phase: 'idle' }

describe('reduceUpdate', () => {
  it('fluxo feliz', () => {
    let s = reduceUpdate(idle, { type: 'check' })
    expect(s.phase).toBe('checking')
    s = reduceUpdate(s, { type: 'available', version: '0.0.2', notes: '- fix' })
    expect(s).toEqual({ phase: 'available', version: '0.0.2', notes: '- fix' })
    s = reduceUpdate(s, { type: 'progress', percent: 42.7 })
    expect(s).toMatchObject({ phase: 'downloading', percent: 43 })
    s = reduceUpdate(s, { type: 'downloaded' })
    expect(s).toMatchObject({ phase: 'ready', version: '0.0.2' })
  })

  it('sem update vai para none (verificado), distinto de idle', () => {
    const s = reduceUpdate({ phase: 'checking' }, { type: 'none' })
    expect(s).toEqual({ phase: 'none' })
    expect(s).not.toEqual(idle)
  })

  it('check a partir de none volta a verificar', () => {
    expect(reduceUpdate({ phase: 'none' }, { type: 'check' })).toEqual({ phase: 'checking' })
  })

  it('erro manual depois de none é exibido', () => {
    expect(reduceUpdate({ phase: 'none' }, { type: 'error', message: 'x' })).toEqual({
      phase: 'error',
      message: 'x'
    })
  })

  it('check durante download não reinicia', () => {
    const s: UpdateState = { phase: 'downloading', version: '1', notes: '', percent: 10 }
    expect(reduceUpdate(s, { type: 'check' })).toBe(s)
  })

  it('check com update pronto não reinicia', () => {
    const s: UpdateState = { phase: 'ready', version: '1', notes: '' }
    expect(reduceUpdate(s, { type: 'check' })).toBe(s)
  })

  it('progress fora de download é ignorado', () => {
    expect(reduceUpdate(idle, { type: 'progress', percent: 5 })).toBe(idle)
  })

  it('erro', () => {
    expect(reduceUpdate(idle, { type: 'error', message: 'x' })).toEqual({
      phase: 'error',
      message: 'x'
    })
  })

  it('erro silencioso (verificação automática) volta para idle', () => {
    expect(
      reduceUpdate({ phase: 'checking' }, { type: 'error', message: 'x', silent: true })
    ).toEqual(idle)
    expect(reduceUpdate(idle, { type: 'error', message: 'x', silent: true })).toEqual(idle)
  })

  it('erro silencioso não derruba download em andamento nem update pronto', () => {
    const d: UpdateState = { phase: 'downloading', version: '1', notes: '', percent: 10 }
    expect(reduceUpdate(d, { type: 'error', message: 'x', silent: true })).toBe(d)
    const r: UpdateState = { phase: 'ready', version: '1', notes: '' }
    expect(reduceUpdate(r, { type: 'error', message: 'x', silent: true })).toBe(r)
  })
})

describe('normalizeNotes', () => {
  it('aceita string, lista e vazio', () => {
    expect(normalizeNotes('a')).toBe('a')
    expect(normalizeNotes([{ note: 'a' }, { note: null }, { note: 'b' }])).toBe('a\n\nb')
    expect(normalizeNotes(null)).toBe('')
  })
})
