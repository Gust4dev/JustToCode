import { create } from 'zustand'
import type { Approval } from '@shared/domain'

// Só zustand e tipos aqui: o reducer e o store são testáveis em Node. O que fala com o
// agent-host (list, decide, eventos) fica em `approvalsFeed.ts`.

export type ApprovalsAction =
  | { type: 'loaded'; approvals: Approval[] }
  | { type: 'requested'; approval: Approval }
  | { type: 'resolved'; approval: Approval }
  | { type: 'removed'; id: string }

const isDecided = (a: Approval): boolean => a.status !== 'pending'

/**
 * Reducer puro da lista de aprovações (ordem de chegada).
 * - `loaded`: o snapshot do host substitui a lista, mas uma decisão já conhecida localmente
 *   não volta a `pending`.
 * - `requested`: acrescenta; id repetido é ignorado.
 * - `resolved`: substitui pelo estado decidido (ou acrescenta, se não era conhecida).
 */
export function approvalsReducer(state: Approval[], action: ApprovalsAction): Approval[] {
  switch (action.type) {
    case 'loaded': {
      const known = new Map(state.map((a) => [a.id, a]))
      return action.approvals.map((a) => {
        const local = known.get(a.id)
        return local && isDecided(local) && !isDecided(a) ? local : a
      })
    }
    case 'requested':
      return state.some((a) => a.id === action.approval.id) ? state : [...state, action.approval]
    case 'resolved': {
      const idx = state.findIndex((a) => a.id === action.approval.id)
      if (idx < 0) return [...state, action.approval]
      const next = state.slice()
      next[idx] = action.approval
      return next
    }
    case 'removed':
      return state.some((a) => a.id === action.id) ? state.filter((a) => a.id !== action.id) : state
  }
}

export interface ApprovalsState {
  approvals: Approval[]
  /** Ids com uma decisão enviada ao host e ainda sem resposta. */
  deciding: Record<string, true>
  dispatch(action: ApprovalsAction): void
  setDeciding(id: string, on: boolean): void
}

export const useApprovals = create<ApprovalsState>((set, get) => ({
  approvals: [],
  deciding: {},
  dispatch: (action) => {
    const prev = get().approvals
    const next = approvalsReducer(prev, action)
    if (next !== prev) set({ approvals: next })
  },
  setDeciding: (id, on) => {
    const deciding = { ...get().deciding }
    if (on) deciding[id] = true
    else delete deciding[id]
    set({ deciding })
  }
}))

export const pendingApprovals = (approvals: Approval[]): Approval[] =>
  approvals.filter((a) => a.status === 'pending')
