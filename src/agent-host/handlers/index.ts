import type { HandlerModule } from '../context'
import { listTables } from '../db'
import { modelsHandlers } from './models'
import { projectHandlers, projectWatchHandlers } from './projects'
import { chatHandlers } from './chats'
import { changesHandlers } from './changes'
import { engineHandlers } from './engine'
import { approvalHandlers } from './approvals'
import { comboHandlers } from './combos'
import { compactionHandlers } from './compaction'
import { ecosystemHandlers } from './ecosystem'
import { gitHandlers } from './git'
import type { Services } from '../services'

export const hostHandlers: HandlerModule = (ctx) => ({
  'host.ping': (): { ok: true; pid: number; version: string } => ({
    ok: true,
    pid: process.pid,
    version: process.env.JTC_VERSION ?? 'dev'
  }),
  'host.dbInfo': (): { userVersion: number; tables: string[] } => ({
    userVersion: ctx.db.pragma('user_version', { simple: true }) as number,
    tables: listTables(ctx.db)
  })
})

// As tasks seguintes só acrescentam módulos a esta lista (uma linha cada).
export const modules: HandlerModule[] = [
  hostHandlers,
  modelsHandlers,
  projectHandlers,
  chatHandlers,
  changesHandlers,
  ecosystemHandlers()
]

/** Módulos que dependem do container de serviços (engine, gate compartilhado). */
export const serviceModules = (s: Services): HandlerModule[] => [
  projectWatchHandlers({
    watchProject: s.watchProject,
    stopWatching: (id) => s.watcher.stop(id)
  }),
  engineHandlers(s.engine),
  approvalHandlers(s.gate),
  comboHandlers({
    resolver: s.comboResolver,
    overrides: s.comboOverrides,
    windows: s.modelWindows
  }),
  compactionHandlers({ engine: s.engine, compactions: s.compactions, messages: s.messages }),
  gitHandlers({ projects: s.projects, model: s.model, getConfig: s.getConfig })
]
