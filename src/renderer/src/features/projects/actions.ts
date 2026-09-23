import { toast } from 'sonner'
import { useUi } from '@renderer/stores/ui'
import { errorMessage, findAnyChat, useProjects } from './store'

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
