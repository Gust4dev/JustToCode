import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FolderPlus, Plus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Toaster } from '@renderer/components/ui/sonner'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { onAgentClient } from '@renderer/lib/agent'
import { useEngineEvent } from '@renderer/lib/engineEvents'
import { useUi } from '@renderer/stores/ui'
import { ChatView } from '@renderer/features/chat/ChatView'
import { DiffPanel } from '@renderer/features/diff/DiffPanel'
import { ComponentsView } from '@renderer/features/components/ComponentsView'
import { InstructionsView } from '@renderer/features/instructions/InstructionsView'
import { initComponentsFeed } from '@renderer/features/components/componentsStore'
import { newChat, pickAndOpenProject } from '@renderer/features/projects/actions'
import { useProjects } from '@renderer/features/projects/store'
import { chatInProject } from '@renderer/features/projects/chatTree'
import { SplitWithRightPanel } from './RightPanel'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

const DIFF_KEY = 'jtc.ui.diffOpen'

function readDiffOpen(): boolean {
  try {
    return localStorage.getItem(DIFF_KEY) !== '0'
  } catch {
    return true
  }
}

function EmptyState({
  title,
  action,
  icon,
  onAction
}: {
  title: string
  action: string
  icon: React.ReactNode
  onAction(): void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <p>{title}</p>
      <Button variant="outline" size="sm" onClick={onAction}>
        {icon}
        {action}
      </Button>
    </div>
  )
}

/** Carrega projetos/chats a cada cliente do host e descarta seleções que sumiram. */
function useProjectData(): void {
  const projectId = useUi((s) => s.projectId)
  const chatId = useUi((s) => s.chatId)
  const projects = useProjects((s) => s.projects)
  const projectsLoaded = useProjects((s) => s.projectsLoaded)
  const chats = useProjects((s) => (projectId ? s.chats[projectId] : undefined))
  const children = useProjects((s) => s.children)

  useEffect(() => {
    let first = true
    return onAgentClient(() => {
      void useProjects.getState().loadProjects()
      // Na primeira conexão o efeito de projectId já pediu os chats; depois de um restart, recarrega.
      const pid = useUi.getState().projectId
      if (!first && pid) void useProjects.getState().loadChats(pid)
      first = false
    })
  }, [])

  useEffect(() => {
    if (projectId) void useProjects.getState().loadChats(projectId)
  }, [projectId])

  useEffect(() => {
    if (projectsLoaded && projectId && !projects.some((p) => p.id === projectId))
      useUi.getState().selectProject(null)
  }, [projectsLoaded, projects, projectId])

  useEffect(() => {
    if (chats && chatId && !chatInProject(chats, children, chatId))
      useUi.getState().selectChat(null)
  }, [chats, children, chatId])

  useEngineEvent((e) => {
    if (e.type === 'subagent_started' || e.type === 'subagent_finished') {
      void useProjects.getState().loadChildren(e.chatId)
      return
    }
    if (e.type === 'chat_updated') {
      useProjects.getState().chatUpdated(e.chat)
      return
    }
    if (e.type !== 'chat_status_changed') return
    if (!useProjects.getState().setChatStatus(e.chatId, e.status)) {
      const pid = useUi.getState().projectId
      if (pid) void useProjects.getState().loadChats(pid)
    }
  })
}

export function AppShell(): React.JSX.Element {
  const projectId = useUi((s) => s.projectId)
  const chatId = useUi((s) => s.chatId)
  const view = useUi((s) => s.view)
  const [diffOpen, setDiffOpen] = useState(readDiffOpen)
  useProjectData()

  // Status/log/progresso dos componentes (9router, llama, downloads) vivem o app inteiro.
  useEffect(() => initComponentsFeed((p) => toast.success(`Download concluído: ${p.label}`)), [])

  const toggleDiff = (): void => {
    const next = !diffOpen
    setDiffOpen(next)
    try {
      localStorage.setItem(DIFF_KEY, next ? '1' : '0')
    } catch {
      // preferência só na memória
    }
  }

  let center: React.JSX.Element
  if (view === 'components') center = <ComponentsView />
  else if (view === 'instructions') center = <InstructionsView />
  else if (!projectId)
    center = (
      <EmptyState
        title="Abra um projeto para começar"
        action="Abrir projeto"
        icon={<FolderPlus />}
        onAction={() => void pickAndOpenProject()}
      />
    )
  else if (!chatId)
    center = (
      <EmptyState
        title="Crie um chat"
        action="Novo chat"
        icon={<Plus />}
        onAction={() => void newChat(projectId)}
      />
    )
  else center = <ChatView key={chatId} chatId={chatId} />

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar diffOpen={diffOpen} onToggleDiff={toggleDiff} />
          <SplitWithRightPanel
            main={center}
            panel={
              view === 'chat' && projectId && diffOpen ? (
                <DiffPanel projectId={projectId} chatId={chatId} />
              ) : null
            }
          />
        </div>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
