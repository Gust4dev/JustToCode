import { create } from 'zustand'
import type {
  ComponentId,
  ComponentStatus,
  ComponentsApi,
  DownloadProgress
} from '@shared/components'
import { appendLog, cleanError } from './format'

export type ComponentsTab = '9router' | 'llama' | 'models'

const TAB_KEY = 'jtc.ui.componentsTab'

function readTab(): ComponentsTab {
  try {
    const v = globalThis.localStorage?.getItem(TAB_KEY)
    return v === 'llama' || v === 'models' ? v : '9router'
  } catch {
    return '9router'
  }
}

export interface ComponentsState {
  /** Aba aberta na tela Componentes (lembrada entre sessões). */
  tab: ComponentsTab
  setTab(tab: ComponentsTab): void
  statuses: Partial<Record<ComponentId, ComponentStatus>>
  /** Erro ao carregar o status (ex.: handler ainda não implementado). */
  statusError: string | null
  logs: Record<ComponentId, string[]>
  /** Downloads conhecidos por id; concluídos sem erro saem do mapa. */
  downloads: Record<string, DownloadProgress>
  setStatus(s: ComponentStatus): void
  setStatuses(list: ComponentStatus[]): void
  setStatusError(msg: string | null): void
  setLogs(id: ComponentId, lines: string[]): void
  appendLog(id: ComponentId, line: string): void
  clearLogs(id: ComponentId): void
  applyProgress(p: DownloadProgress): void
  dismissDownload(id: string): void
}

export function applyProgressTo(
  prev: Record<string, DownloadProgress>,
  p: DownloadProgress
): Record<string, DownloadProgress> {
  const next = { ...prev }
  if (p.done && !p.error) delete next[p.id]
  else next[p.id] = p
  return next
}

export const useComponents = create<ComponentsState>((set) => ({
  tab: readTab(),
  setTab: (tab) => {
    set({ tab })
    try {
      globalThis.localStorage?.setItem(TAB_KEY, tab)
    } catch {
      // preferência só na memória
    }
  },
  statuses: {},
  statusError: null,
  logs: { '9router': [], llama: [] },
  downloads: {},
  setStatus: (s) => set((st) => ({ statuses: { ...st.statuses, [s.id]: s }, statusError: null })),
  setStatuses: (list) =>
    set((st) => {
      const statuses = { ...st.statuses }
      for (const s of list) statuses[s.id] = s
      return { statuses, statusError: null }
    }),
  setStatusError: (msg) => set({ statusError: msg }),
  setLogs: (id, lines) => set((st) => ({ logs: { ...st.logs, [id]: appendLog([], lines) } })),
  appendLog: (id, line) =>
    set((st) => ({ logs: { ...st.logs, [id]: appendLog(st.logs[id], [line]) } })),
  clearLogs: (id) => set((st) => ({ logs: { ...st.logs, [id]: [] } })),
  applyProgress: (p) => set((st) => ({ downloads: applyProgressTo(st.downloads, p) })),
  dismissDownload: (id) =>
    set((st) => {
      const downloads = { ...st.downloads }
      delete downloads[id]
      return { downloads }
    })
}))

/** `window.api.components`, ou `null` fora do Electron (testes). */
export function componentsApi(): ComponentsApi | null {
  const w = globalThis as { api?: { components?: ComponentsApi } }
  return w.api?.components ?? null
}

/** Recarrega o status de todos os componentes. */
export async function refreshStatus(): Promise<void> {
  const api = componentsApi()
  if (!api) return
  try {
    useComponents.getState().setStatuses(await api.status())
  } catch (e) {
    useComponents.getState().setStatusError(cleanError(e))
  }
}

/**
 * Assina os eventos do main (status, log, progresso) e carrega o status inicial.
 * Chamado uma vez pelo AppShell; devolve a função que desfaz as assinaturas.
 */
export function initComponentsFeed(onDownloadDone?: (p: DownloadProgress) => void): () => void {
  const api = componentsApi()
  if (!api) return () => {}
  const st = useComponents.getState
  const offs = [
    api.onStatus((s) => st().setStatus(s)),
    api.onLog((e) => st().appendLog(e.id, e.line)),
    api.onProgress((p) => {
      const known = p.id in st().downloads
      st().applyProgress(p)
      if (known && p.done && !p.error) onDownloadDone?.(p)
    })
  ]
  void refreshStatus()
  return () => offs.forEach((off) => off())
}
