import type { HostParams, HostResult } from '@shared/api'
import type { HandlerModule } from '../context'
import type { PermissionGate } from '../services/types'

/** Registrado pelo engine (Task 1.6), que monta o gate compartilhado. */
export function approvalHandlers(gate: PermissionGate): HandlerModule {
  return () => ({
    'approvals.list': (p: HostParams<'approvals.list'>): HostResult<'approvals.list'> =>
      gate.list(p?.chatId),
    'approvals.decide': (p: HostParams<'approvals.decide'>): HostResult<'approvals.decide'> => {
      gate.resolve(p.id, p.decision, p.remember)
      return null
    }
  })
}
