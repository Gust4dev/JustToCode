import { create } from 'zustand'
import type { Chat, ChatStatus, PermissionMode, Project } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { findChatIn, removeFromChildren, upsertChild } from './chatTree'

export interface ProjectsState {
  projects: Project[]
  projectsLoaded: boolean
  projectsError: string | null
  /** Chats de topo por projeto (ordem do host: mais novo primeiro). */
  chats: Record<string, Chat[]>
  chatsError: Record<string, string | null>
  /** Chats filhos (subagentes) por id do chat pai. */
  children: Record<string, Chat[]>
  loadProjects(): Promise<void>
  openProject(path: string): Promise<Project>
  removeProject(id: string): Promise<void>
  loadChats(projectId: string): Promise<void>
  createChat(projectId: string): Promise<Chat>
  renameChat(id: string, title: string): Promise<void>
  /** `chats.update` de combo/modo de permissão; atualiza o chat no store. */
  updateChat(id: string, patch: { combo?: string; permissionMode?: PermissionMode }): Promise<void>
  deleteChat(id: string): Promise<void>
  /** Recarrega os filhos de um chat (`chats.children`); host sem o método → sem filhos. */
  loadChildren(parentId: string): Promise<void>
  /** Atualiza o status de um chat conhecido; devolve false se o chat não está carregado. */
  setChatStatus(chatId: string, status: ChatStatus): boolean
}

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'Erro desconhecido'

function replaceChat(chats: Record<string, Chat[]>, chat: Chat): Record<string, Chat[]> {
  const list = chats[chat.projectId] ?? []
  const idx = list.findIndex((c) => c.id === chat.id)
  const next = idx >= 0 ? list.map((c) => (c.id === chat.id ? chat : c)) : [chat, ...list]
  return { ...chats, [chat.projectId]: next }
}

const isUnknownMethod = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === 'UNKNOWN_METHOD'

/** Filhos de cada chat; o primeiro UNKNOWN_METHOD (host sem subagentes) encerra com mapa vazio. */
async function fetchChildren(parents: Chat[]): Promise<Record<string, Chat[]> | null> {
  if (parents.length === 0) return {}
  try {
    const lists = await Promise.all(parents.map((c) => call('chats.children', { chatId: c.id })))
    const out: Record<string, Chat[]> = {}
    parents.forEach((c, i) => {
      if (lists[i].length > 0) out[c.id] = lists[i]
    })
    return out
  } catch (e) {
    return isUnknownMethod(e) ? {} : null
  }
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  projectsLoaded: false,
  projectsError: null,
  chats: {},
  chatsError: {},
  children: {},

  loadProjects: async () => {
    try {
      const projects = await call('projects.list', null)
      set({ projects, projectsLoaded: true, projectsError: null })
    } catch (e) {
      set({ projectsError: errorMessage(e) })
    }
  },

  openProject: async (path) => {
    const project = await call('projects.open', { path })
    const rest = get().projects.filter((p) => p.id !== project.id)
    set({ projects: [project, ...rest], projectsLoaded: true, projectsError: null })
    return project
  },

  removeProject: async (id) => {
    await call('projects.remove', { id })
    const chats = { ...get().chats }
    delete chats[id]
    set({ projects: get().projects.filter((p) => p.id !== id), chats })
  },

  loadChats: async (projectId) => {
    try {
      const list = await call('chats.list', { projectId })
      // Filhos junto com a lista: a seleção de um chat filho não some enquanto eles carregam.
      const kids = await fetchChildren(list)
      const children = { ...get().children }
      if (kids) {
        for (const c of list) delete children[c.id]
        Object.assign(children, kids)
      }
      set({
        chats: { ...get().chats, [projectId]: list },
        chatsError: { ...get().chatsError, [projectId]: null },
        children
      })
    } catch (e) {
      set({ chatsError: { ...get().chatsError, [projectId]: errorMessage(e) } })
    }
  },

  createChat: async (projectId) => {
    const chat = await call('chats.create', { projectId })
    set({ chats: replaceChat(get().chats, chat) })
    return chat
  },

  renameChat: async (id, title) => {
    const chat = await call('chats.update', { id, title })
    set({ chats: replaceChat(get().chats, chat) })
  },

  updateChat: async (id, patch) => {
    const chat = await call('chats.update', { id, ...patch })
    set({ chats: replaceChat(get().chats, chat) })
  },

  deleteChat: async (id) => {
    await call('chats.delete', { id })
    const chats: Record<string, Chat[]> = {}
    for (const [pid, list] of Object.entries(get().chats)) {
      chats[pid] = list.filter((c) => c.id !== id)
    }
    set({ chats, children: removeFromChildren(get().children, id) })
  },

  loadChildren: async (parentId) => {
    try {
      const list = await call('chats.children', { chatId: parentId })
      set({ children: { ...get().children, [parentId]: list } })
    } catch {
      // host sem subagentes ou erro transitório: mantém o que havia
    }
  },

  setChatStatus: (chatId, status) => {
    for (const list of Object.values(get().chats)) {
      const chat = list.find((c) => c.id === chatId)
      if (chat) {
        if (chat.status !== status) set({ chats: replaceChat(get().chats, { ...chat, status }) })
        return true
      }
    }
    for (const list of Object.values(get().children)) {
      const chat = list.find((c) => c.id === chatId)
      if (chat) {
        if (chat.status !== status)
          set({ children: upsertChild(get().children, { ...chat, status }) })
        return true
      }
    }
    return false
  }
}))

export function findChat(chats: Record<string, Chat[]>, chatId: string | null): Chat | null {
  return findChatIn(chats, {}, chatId)
}

/** Procura entre os chats de topo e os filhos (subagentes). */
export function findAnyChat(
  s: Pick<ProjectsState, 'chats' | 'children'>,
  chatId: string | null
): Chat | null {
  return findChatIn(s.chats, s.children, chatId)
}
