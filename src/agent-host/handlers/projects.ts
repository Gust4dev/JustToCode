import { existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { RpcError } from '@shared/rpc'
import type { HostParams, HostResult } from '@shared/api'
import type { HandlerModule } from '../context'
import { ProjectRepo } from '../repo/projects'

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export const projectHandlers: HandlerModule = (ctx) => {
  const projects = new ProjectRepo(ctx.db)
  return {
    'projects.open': ({ path }: HostParams<'projects.open'>): HostResult<'projects.open'> => {
      if (typeof path !== 'string' || path.trim() === '') {
        throw new RpcError('Caminho inválido', 'INVALID_PATH')
      }
      const abs = resolve(path)
      if (!isDir(abs)) throw new RpcError('A pasta não existe', 'NOT_FOUND')
      // `.git` pode ser pasta (repo normal) ou arquivo (worktree/submódulo).
      if (!existsSync(join(abs, '.git'))) {
        throw new RpcError('A pasta não é um repositório git', 'NOT_GIT_REPO')
      }
      const existing = projects.getByPath(abs)
      if (existing) {
        projects.touch(existing.id)
        return projects.get(existing.id) ?? existing
      }
      return projects.create(abs, basename(abs) || abs)
    },
    'projects.list': (): HostResult<'projects.list'> => projects.list(),
    'projects.remove': ({ id }: HostParams<'projects.remove'>): HostResult<'projects.remove'> => {
      projects.remove(id)
      return null
    }
  }
}

/**
 * Sobrescreve `projects.open`/`projects.remove` (módulo de serviço, registrado depois de
 * `projectHandlers`) para ligar e desligar o watcher de arquivos do projeto.
 */
export const projectWatchHandlers =
  (w: {
    watchProject(projectId: string): void
    stopWatching(projectId: string): Promise<void>
  }): HandlerModule =>
  (ctx) => {
    const base = projectHandlers(ctx)
    return {
      'projects.open': (p: HostParams<'projects.open'>): HostResult<'projects.open'> => {
        const project = base['projects.open'](p) as HostResult<'projects.open'>
        w.watchProject(project.id)
        return project
      },
      'projects.remove': async (
        p: HostParams<'projects.remove'>
      ): Promise<HostResult<'projects.remove'>> => {
        await w.stopWatching(p.id)
        return base['projects.remove'](p) as HostResult<'projects.remove'>
      }
    }
  }
