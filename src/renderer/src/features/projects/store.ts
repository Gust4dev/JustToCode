import { create } from 'zustand'
import type {
  Chat,
  ChatGroup,
  ChatSettings,
  ChatStatus,
  PermissionMode,
  Project
} from '@shared/domain'
import { call } from '@renderer/lib/host'
import { findChatIn, removeFromChildren, upsertChild } from './chatTree'
import { setChatGroup, ungroupChats } from './groupTree'
import { applyChatUpdate } from './chatUpdate'

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
  /** `chats.update` de combo/modo/limites; atualiza o chat no store. */
  updateChat(
    id: string,
    patch: {
      combo?: string
      permissionMode?: PermissionMode
      maxIterations?: number | null
      tokenBudget?: number | null
      settings?: Partial<ChatSettings>
    }
  ): Promise<void>
  /** Aplica um chat vindo do host (`chat_updated`); devolve false se ele não está carregado. */
  chatUpdated(chat: Chat): boolean
  /** `chats.generateTitle`; atualiza o chat no store. */
  generateTitle(id: string): Promise<void>
  deleteChat(id: string): Promise<void>
  /** Recarrega os filhos de um chat (`chats.children`); host sem o método → sem filhos. */
  loadChildren(parentId: string): Promise<void>
  /** Atualiza o status de um chat conhecido; devolve false se o chat não está carregado. */
  setChatStatus(chatId: string, status: ChatStatus): boolean
  /** Grupos de chats por projeto. */
  groups: Record<string, ChatGroup[]>
  /** false quando o host não tem `groups.*` (UNKNOWN_METHOD): a sidebar esconde os grupos. */
  groupsSupported: boolean
  loadGroups(projectId: string): Promise<void>
  createGroup(projectId: string, name: string): Promise<ChatGroup>
  updateGroup(id: string, patch: { name?: string; collapsed?: boolean }): Promise<void>
  /** Aplica uma reordenação já calculada (otimista) e grava os `sortOrder` alterados. */
  reorderGroups(
    projectId: string,
    groups: ChatGroup[],
    changed: { id: string; sortOrder: number }[]
  ): Promise<void>
  deleteGroup(id: string): Promise<void>
  /** Move um chat de topo para um grupo (null = sem grupo). */
  moveChatToGroup(chatId: string, groupId: string | null): Promise<void>
  /** `chats.continue`: recarrega chats/grupos do projeto (o host pode criar grupo e mover o original). */
  continueChat(chatId: string): Promise<Chat>
}

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'Erro desconhecido'

function replaceChat(chats: Record<string, Chat[]>, chat: Chat): Record<string, Chat[]> {
  const list = chats[chat.projectId] ?? []
  const idx = list.findIndex((c) => c.id === chat.id)
  const next = idx >= 0 ? list.map((c) => (c.id === chat.id ? chat : c)) : [chat, ...list]
  return { ...chats, [chat.projectId]: next }
}

export const isUnknownMethod = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === 'UNKNOWN_METHOD'

function replaceGroup(
  groups: Record<string, ChatGroup[]>,
  group: ChatGroup
): Record<string, ChatGroup[]> {
  const list = groups[group.projectId] ?? []
  const next = list.some((g) => g.id === group.id)
    ? list.map((g) => (g.id === group.id ? group : g))
    : [...list, group]
  return { ...groups, [group.projectId]: next }
}

function projectOfGroup(groups: Record<string, ChatGroup[]>, id: string): string | null {
  for (const [pid, list] of Object.entries(groups)) if (list.some((g) => g.id === id)) return pid
  return null
}

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
  groups: {},
  groupsSupported: true,

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
    void get().loadGroups(projectId)
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
    if (!get().chatUpdated(chat)) set({ chats: replaceChat(get().chats, chat) })
  },

  chatUpdated: (chat) => {
    const next = applyChatUpdate(get().chats, get().children, chat)
    if (!next) return false
    set(next)
    return true
  },

  generateTitle: async (id) => {
    const chat = await call('chats.generateTitle', { chatId: id })
    get().chatUpdated(chat)
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
  },

  loadGroups: async (projectId) => {
    if (!get().groupsSupported) return
    try {
      const list = await call('groups.list', { projectId })
      set({ groups: { ...get().groups, [projectId]: list } })
    } catch (e) {
      // host sem grupos: esconde a UI; erro transitório mantém o que havia
      if (isUnknownMethod(e)) set({ groupsSupported: false })
    }
  },

  createGroup: async (projectId, name) => {
    const group = await call('groups.create', { projectId, name })
    set({ groups: replaceGroup(get().groups, group) })
    return group
  },

  updateGroup: async (id, patch) => {
    const pid = projectOfGroup(get().groups, id)
    const before = pid ? get().groups[pid] : null
    // Otimista (recolher precisa responder na hora); volta atrás se o host recusar.
    if (pid && before)
      set({
        groups: {
          ...get().groups,
          [pid]: before.map((g) => (g.id === id ? { ...g, ...patch } : g))
        }
      })
    try {
      const group = await call('groups.update', { id, ...patch })
      set({ groups: replaceGroup(get().groups, group) })
    } catch (e) {
      if (pid && before) set({ groups: { ...get().groups, [pid]: before } })
      throw e
    }
  },

  reorderGroups: async (projectId, groups, changed) => {
    const before = get().groups[projectId] ?? []
    set({ groups: { ...get().groups, [projectId]: groups } })
    try {
      await Promise.all(changed.map((c) => call('groups.update', c)))
    } catch (e) {
      set({ groups: { ...get().groups, [projectId]: before } })
      void get().loadGroups(projectId)
      throw e
    }
  },

  deleteGroup: async (id) => {
    await call('groups.delete', { id })
    const pid = projectOfGroup(get().groups, id)
    if (!pid) return
    set({
      groups: { ...get().groups, [pid]: get().groups[pid].filter((g) => g.id !== id) },
      chats: { ...get().chats, [pid]: ungroupChats(get().chats[pid] ?? [], id) }
    })
  },

  moveChatToGroup: async (chatId, groupId) => {
    const chat = findChat(get().chats, chatId)
    if (!chat || chat.groupId === groupId) return
    const pid = chat.projectId
    set({ chats: { ...get().chats, [pid]: setChatGroup(get().chats[pid] ?? [], chatId, groupId) } })
    try {
      const updated = await call('chats.update', { id: chatId, groupId })
      set({ chats: replaceChat(get().chats, updated) })
    } catch (e) {
      set({
        chats: { ...get().chats, [pid]: setChatGroup(get().chats[pid] ?? [], chatId, chat.groupId) }
      })
      throw e
    }
  },

  continueChat: async (chatId) => {
    const chat = await call('chats.continue', { chatId })
    set({ chats: replaceChat(get().chats, chat) })
    await get().loadChats(chat.projectId)
    return chat
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
