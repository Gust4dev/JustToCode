import { describe, it, expect, vi } from 'vitest'
import type { SlashCommand } from '@shared/domain'
import {
  filterCommands,
  moveIndex,
  parseSlashCommand,
  resolveSlashText,
  slashQuery
} from '../../src/renderer/src/features/chat/slashCommands'

const cmd = (name: string, description = ''): SlashCommand => ({
  name,
  description,
  source: 'command',
  path: `/x/${name}.md`,
  scope: 'global'
})

describe('slashQuery', () => {
  it('só abre com / no início e antes do primeiro espaço', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/rev')).toBe('rev')
    expect(slashQuery('/review agora')).toBeNull()
    expect(slashQuery('/a\nb')).toBeNull()
    expect(slashQuery('oi /rev')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })
})

describe('filterCommands', () => {
  const list = [cmd('zeta', 'faz review'), cmd('review'), cmd('prereview'), cmd('deploy')]
  it('prefixo antes de substring antes de descrição', () => {
    expect(filterCommands(list, 'rev').map((c) => c.name)).toEqual(['review', 'prereview', 'zeta'])
  })
  it('sem filtro devolve tudo em ordem alfabética', () => {
    expect(filterCommands(list, '').map((c) => c.name)).toEqual([
      'deploy',
      'prereview',
      'review',
      'zeta'
    ])
  })
  it('ignora caixa e respeita o limite', () => {
    expect(filterCommands(list, 'DEP').map((c) => c.name)).toEqual(['deploy'])
    expect(filterCommands(list, '', 2)).toHaveLength(2)
  })
})

describe('parseSlashCommand', () => {
  it('separa nome e argumentos', () => {
    expect(parseSlashCommand('/review src/a.ts  agora')).toEqual({
      name: 'review',
      args: 'src/a.ts  agora'
    })
    expect(parseSlashCommand('/review')).toEqual({ name: 'review', args: '' })
    expect(parseSlashCommand('/review\nlinha 2')).toEqual({ name: 'review', args: 'linha 2' })
  })
  it('não é comando', () => {
    expect(parseSlashCommand('oi')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand('/usr/bin/env')).toBeNull()
  })
})

describe('moveIndex', () => {
  it('é circular', () => {
    expect(moveIndex(0, -1, 3)).toBe(2)
    expect(moveIndex(2, 1, 3)).toBe(0)
    expect(moveIndex(1, 1, 3)).toBe(2)
    expect(moveIndex(0, 1, 0)).toBe(0)
  })
})

describe('resolveSlashText', () => {
  const list = [cmd('review')]
  it('expande comando conhecido', async () => {
    const expand = vi.fn(async (name: string, args: string) => ({ text: `EXP ${name} ${args}` }))
    expect(await resolveSlashText('/review a.ts', list, expand)).toBe('EXP review a.ts')
    expect(expand).toHaveBeenCalledWith('review', 'a.ts')
  })
  it('comando inexistente e texto normal vão como estão', async () => {
    const expand = vi.fn(async () => ({ text: 'nunca' }))
    expect(await resolveSlashText('/nada x', list, expand)).toBe('/nada x')
    expect(await resolveSlashText('oi', list, expand)).toBe('oi')
    expect(expand).not.toHaveBeenCalled()
  })
  it('host sem expandCommand → texto normal; outros erros sobem', async () => {
    const unknown = Object.assign(new Error('método desconhecido'), { code: 'UNKNOWN_METHOD' })
    expect(await resolveSlashText('/review', list, () => Promise.reject(unknown))).toBe('/review')
    await expect(
      resolveSlashText('/review', list, () => Promise.reject(new Error('falhou')))
    ).rejects.toThrow('falhou')
  })
})
