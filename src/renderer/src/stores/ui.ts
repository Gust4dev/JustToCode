import { create } from 'zustand'

/** O que ocupa a área central: a conversa, a tela Componentes ou a tela Instruções. Não é persistido. */
export type UiView = 'chat' | 'components' | 'instructions'

export interface UiState {
  projectId: string | null
  chatId: string | null
  view: UiView
  selectProject(id: string | null): void
  selectChat(id: string | null): void
  setView(view: UiView): void
}

const KEY = 'jtc.ui.selection'

type Selection = Pick<UiState, 'projectId' | 'chatId'>

function readSelection(): Selection {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return { projectId: null, chatId: null }
    const v = JSON.parse(raw) as Partial<Selection>
    return {
      projectId: typeof v.projectId === 'string' ? v.projectId : null,
      chatId: typeof v.chatId === 'string' ? v.chatId : null
    }
  } catch {
    return { projectId: null, chatId: null }
  }
}

function writeSelection(s: Selection): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s))
  } catch {
    // sem localStorage (teste, modo restrito): a seleção só vive na memória
  }
}

export const useUi = create<UiState>((set, get) => ({
  ...readSelection(),
  view: 'chat',
  // Escolher um projeto/chat de verdade volta para a conversa; limpar seleção (null) não mexe na view.
  selectProject: (id) => {
    const s = get()
    const next: Selection = { projectId: id, chatId: id === s.projectId ? s.chatId : null }
    set(id === null ? next : { ...next, view: 'chat' })
    writeSelection(next)
  },
  selectChat: (id) => {
    const next: Selection = { projectId: get().projectId, chatId: id }
    set(id === null ? next : { ...next, view: 'chat' })
    writeSelection(next)
  },
  setView: (view) => set({ view })
}))
