import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadWindowState,
  parseWindowState,
  resolveInitialWindow,
  saveWindowState
} from '../../src/main/windowState'

const big = { x: 0, y: 0, width: 2560, height: 1400 }
const small = { x: 0, y: 0, width: 1366, height: 728 }
const second = { x: 2560, y: 0, width: 1920, height: 1040 }

describe('parseWindowState', () => {
  it('aceita estado válido', () => {
    const s = parseWindowState(
      JSON.stringify({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true })
    )
    expect(s).toEqual({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true })
  })
  it('rejeita JSON corrompido ou campos inválidos', () => {
    expect(parseWindowState('{nope')).toBeNull()
    expect(parseWindowState('null')).toBeNull()
    expect(
      parseWindowState(JSON.stringify({ bounds: { x: 'a', y: 0, width: 1, height: 1 } }))
    ).toBeNull()
    expect(
      parseWindowState(JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 5 } }))
    ).toBeNull()
  })
})

describe('resolveInitialWindow', () => {
  it('sem estado: 1440×900 centralizado no primário', () => {
    expect(resolveInitialWindow(null, [big], big)).toEqual({
      bounds: { x: 560, y: 250, width: 1440, height: 900 },
      maximized: false
    })
  })
  it('sem estado em tela pequena: limita à área de trabalho', () => {
    expect(resolveInitialWindow(null, [small], small).bounds).toEqual({
      x: 0,
      y: 0,
      width: 1366,
      height: 728
    })
  })
  it('restaura estado salvo no segundo monitor', () => {
    const saved = { bounds: { x: 2700, y: 50, width: 1300, height: 900 }, maximized: true }
    expect(resolveInitialWindow(saved, [big, second], big)).toEqual(saved)
  })
  it('monitor que não existe mais: volta ao padrão', () => {
    const saved = { bounds: { x: 2700, y: 50, width: 1300, height: 900 }, maximized: true }
    expect(resolveInitialWindow(saved, [big], big)).toEqual({
      bounds: { x: 560, y: 250, width: 1440, height: 900 },
      maximized: false
    })
  })
  it('encaixa janela parcialmente fora da tela e respeita o mínimo', () => {
    const saved = { bounds: { x: -300, y: 1300, width: 500, height: 300 }, maximized: false }
    expect(resolveInitialWindow(saved, [big], big).bounds).toEqual({
      x: 0,
      y: 760,
      width: 1024,
      height: 640
    })
  })
})

describe('load/save', () => {
  it('ida e volta; arquivo ausente ou corrompido devolve null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jtc-win-'))
    const f = join(dir, 'window-state.json')
    expect(loadWindowState(f)).toBeNull()
    const s = { bounds: { x: 1, y: 2, width: 1100, height: 700 }, maximized: false }
    saveWindowState(f, s)
    expect(loadWindowState(f)).toEqual(s)
    writeFileSync(f, 'lixo')
    expect(loadWindowState(f)).toBeNull()
  })
})
