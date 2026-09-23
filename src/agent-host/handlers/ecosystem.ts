import type { AppConfig, Project } from '@shared/domain'
import type { HostParams, HostResult } from '@shared/api'
import { RpcError } from '@shared/rpc'
import type { HandlerModule } from '../context'
import { getConfig as getHostConfig } from '../config'
import { ProjectRepo } from '../repo/projects'
import { loadInstructions } from '../ecosystem/instructions'
import { discoverSkills } from '../ecosystem/skills'
import { expandCommand, listCommands, type EcosystemRoots } from '../ecosystem/commands'
import { availableAgents } from '../ecosystem/agents'

/** Handlers `ecosystem.*` (instruções, skills e slash commands). `getConfig` é injetável nos testes. */
export const ecosystemHandlers =
  (getConfig: () => AppConfig = getHostConfig): HandlerModule =>
  (ctx) => {
    const projects = new ProjectRepo(ctx.db)
    const project = (id: string): Project => {
      const p = typeof id === 'string' ? projects.get(id) : null
      if (!p) throw new RpcError('Projeto não encontrado', 'NOT_FOUND')
      return p
    }
    const roots = (): EcosystemRoots => {
      const cfg = getConfig()
      return {
        skillRoots: cfg.skillRoots ?? [],
        commandRoots: cfg.commandRoots ?? [],
        pluginRoots: cfg.pluginRoots ?? []
      }
    }
    return {
      'ecosystem.instructions': ({
        projectId
      }: HostParams<'ecosystem.instructions'>): HostResult<'ecosystem.instructions'> =>
        loadInstructions(project(projectId).path, getConfig().instructionFiles ?? []).files,
      'ecosystem.agents': ({
        projectId
      }: HostParams<'ecosystem.agents'>): HostResult<'ecosystem.agents'> =>
        availableAgents(project(projectId).path, getConfig().agentRoots ?? []),
      'ecosystem.skills': ({
        projectId
      }: HostParams<'ecosystem.skills'>): HostResult<'ecosystem.skills'> => {
        const r = roots()
        return discoverSkills(project(projectId).path, r.skillRoots, r.pluginRoots)
      },
      'ecosystem.commands': ({
        projectId
      }: HostParams<'ecosystem.commands'>): HostResult<'ecosystem.commands'> =>
        listCommands(project(projectId).path, roots()),
      'ecosystem.expandCommand': ({
        projectId,
        name,
        args
      }: HostParams<'ecosystem.expandCommand'>): HostResult<'ecosystem.expandCommand'> => {
        if (typeof name !== 'string' || !name.trim()) {
          throw new RpcError('Comando inválido', 'INVALID_PARAMS')
        }
        const text = expandCommand(
          project(projectId).path,
          roots(),
          name,
          typeof args === 'string' ? args : ''
        )
        if (text === null) throw new RpcError(`Comando não encontrado: /${name}`, 'NOT_FOUND')
        return { text }
      }
    }
  }
