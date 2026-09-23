import { create } from 'zustand'
import type { ModelInfo } from '@shared/domain'
import { call } from '@renderer/lib/host'

const TTL_MS = 5 * 60 * 1000

export interface ModelsState {
  models: ModelInfo[]
  loadedAt: number
  loading: boolean
  error: string | null
  /** Busca `models.list` se o cache estiver vazio ou com mais de 5 min (ou `force`). */
  load(force?: boolean): Promise<void>
}

/** Combos primeiro, depois os modelos; cada grupo em ordem alfabética. */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) =>
    a.isCombo !== b.isCombo ? (a.isCombo ? -1 : 1) : a.id.localeCompare(b.id)
  )
}

let inflight: Promise<void> | null = null

export const useModels = create<ModelsState>((set, get) => ({
  models: [],
  loadedAt: 0,
  loading: false,
  error: null,
  load: (force = false) => {
    const { loadedAt } = get()
    if (!force && loadedAt > 0 && Date.now() - loadedAt < TTL_MS) return Promise.resolve()
    if (inflight) return inflight
    set({ loading: true })
    inflight = call('models.list', null)
      .then((list) => set({ models: sortModels(list), loadedAt: Date.now(), error: null }))
      .catch((e: unknown) => set({ error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        inflight = null
        set({ loading: false })
      })
    return inflight
  }
}))

/** Mantém o cache de modelos atualizado a cada 5 min enquanto houver assinantes. */
let refreshers = 0
let timer: ReturnType<typeof setInterval> | null = null
export function retainModelsRefresh(): () => void {
  refreshers++
  void useModels.getState().load()
  if (!timer) timer = setInterval(() => void useModels.getState().load(true), TTL_MS)
  return () => {
    refreshers--
    if (refreshers <= 0 && timer) {
      clearInterval(timer)
      timer = null
      refreshers = 0
    }
  }
}
