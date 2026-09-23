import type { HostParams, HostResult } from '@shared/api'
import type { HandlerModule } from '../context'
import { createChangesService } from '../attribution/changesService'
import { FileChangeRepo } from '../repo/fileChanges'
import { ProjectRepo } from '../repo/projects'

export const changesHandlers: HandlerModule = (ctx) => {
  const svc = createChangesService(ctx, new FileChangeRepo(ctx.db), new ProjectRepo(ctx.db))
  return {
    'changes.list': (p: HostParams<'changes.list'>): Promise<HostResult<'changes.list'>> =>
      svc.list(p),
    'changes.fileDiff': (
      p: HostParams<'changes.fileDiff'>
    ): Promise<HostResult<'changes.fileDiff'>> => svc.fileDiff(p),
    'changes.accept': (p: HostParams<'changes.accept'>): HostResult<'changes.accept'> =>
      svc.accept(p),
    'changes.revert': (p: HostParams<'changes.revert'>): Promise<HostResult<'changes.revert'>> =>
      svc.revert(p),
    'changes.resolveConflict': (
      p: HostParams<'changes.resolveConflict'>
    ): Promise<HostResult<'changes.resolveConflict'>> => svc.resolveConflict(p)
  }
}
