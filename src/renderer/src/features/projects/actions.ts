import { toast } from 'sonner'
import { useUi } from '@renderer/stores/ui'
import { errorMessage, findAnyChat, isUnknownMethod, useProjects } from './store'

/** Abre o seletor de pasta e registra o projeto; erros viram toast. */
export async function pickAndOpenProject(): Promise<void> {
  let path: string | null
  try {
    path = await window.api.dialog.pickFolder()
  } catch (e) {
    toast.error(`Não foi possível abrir o seletor de pasta: ${errorMessage(e)}`)
    return
  }
  if (!path) return
  try {
    const project = await useProjects.getState().openProject(path)
    useUi.getState().selectProject(project.id)
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code
    if (code === 'NOT_GIT_REPO') toast.error(errorMessage(e), { description: path })
    else toast.error(`Não foi possível abrir o projeto: ${errorMessage(e)}`)
  }
}

export async function newChat(projectId: string): Promise<void> {
  try {
    const chat = await useProjects.getState().createChat(projectId)
    const ui = useUi.getState()
    if (ui.projectId !== projectId) ui.selectProject(projectId)
    useUi.getState().selectChat(chat.id)
  } catch (e) {
    toast.error(`Não foi possível criar o chat: ${errorMessage(e)}`)
  }
}

const unavailable = (e: unknown, what: string): string =>
  isUnknownMethod(e) ? `o agent-host ainda não oferece ${what}.` : errorMessage(e)

/** `chats.continue`: abre o chat novo (resumo do original como primeira mensagem). */
export async function continueInNewChat(chatId: string): Promise<void> {
  try {
    const chat = await useProjects.getState().continueChat(chatId)
    const ui = useUi.getState()
    if (ui.projectId !== chat.projectId) ui.selectProject(chat.projectId)
    useUi.getState().selectChat(chat.id)
  } catch (e) {
    toast.error(`Não foi possível continuar em novo chat: ${unavailable(e, 'a continuação')}`)
  }
}

export async function moveChatToGroup(chatId: string, groupId: string | null): Promise<void> {
  try {
    await useProjects.getState().moveChatToGroup(chatId, groupId)
  } catch (e) {
    toast.error(`Não foi possível mover o chat: ${unavailable(e, 'grupos')}`)
  }
}

/** Cria um grupo; com `chatId`, move esse chat para ele. Devolve o id ou null. */
export async function newGroup(
  projectId: string,
  name: string,
  chatId?: string
): Promise<string | null> {
  try {
    const group = await useProjects.getState().createGroup(projectId, name)
    if (chatId) await moveChatToGroup(chatId, group.id)
    return group.id
  } catch (e) {
    toast.error(`Não foi possível criar o grupo: ${unavailable(e, 'grupos')}`)
    return null
  }
}

/** Abre o chat de um subagente; carrega os filhos do pai antes, se ainda não estão no store. */
export async function openChildChat(parentChatId: string, childChatId: string): Promise<void> {
  const s = useProjects.getState()
  if (!findAnyChat(s, childChatId)) await s.loadChildren(parentChatId)
  if (!findAnyChat(useProjects.getState(), childChatId)) {
    toast.error('Conversa do subagente não encontrada.')
    return
  }
  useUi.getState().selectChat(childChatId)
}
