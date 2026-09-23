import type { HostParams, HostResult } from '@shared/api'
import type { AppConfig } from '@shared/domain'
import { RpcError } from '@shared/rpc'
import type { HandlerModule } from '../context'
import type { ModelClient } from '../model/types'
import type { ProjectRepo } from '../repo/projects'
import { generateCommitMessage } from '../git/commitMessage'

/** Registrado a partir do container de serviços. Só gera a mensagem; nunca commita. */
export function gitHandlers(d: {
  projects: ProjectRepo
  model: ModelClient
  getConfig: () => AppConfig
}): HandlerModule {
  return () => ({
    'git.commitMessage': (
      p: HostParams<'git.commitMessage'>
    ): Promise<HostResult<'git.commitMessage'>> => {
      const project = d.projects.get(p.projectId)
      if (!project) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
      return generateCommitMessage({ root: project.path, model: d.model, cfg: d.getConfig() })
    }
  })
}
