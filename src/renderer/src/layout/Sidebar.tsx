import { Boxes, FolderPlus, ScrollText, Settings } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ProjectList } from '@renderer/features/projects/ProjectList'
import { pickAndOpenProject } from '@renderer/features/projects/actions'
import { SettingsDialog } from '@renderer/features/settings/SettingsDialog'
import { useSettingsDialog } from '@renderer/stores/settingsDialog'
import { useUi } from '@renderer/stores/ui'
import { cn } from '@renderer/lib/utils'

export function Sidebar(): React.JSX.Element {
  const settingsOpen = useSettingsDialog((s) => s.open)
  const setSettingsOpen = useSettingsDialog((s) => s.setOpen)
  const view = useUi((s) => s.view)
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/40">
      <div className="flex h-10 shrink-0 items-center justify-between pr-2 pl-3">
        <span className="text-xs font-medium text-muted-foreground">Projetos</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Abrir projeto"
              onClick={() => void pickAndOpenProject()}
            >
              <FolderPlus />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Abrir projeto</TooltipContent>
        </Tooltip>
      </div>
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <ProjectList />
      </ScrollArea>
      <div className="flex shrink-0 flex-col gap-0.5 border-t p-2">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={view === 'components'}
          className={cn(
            'h-7 w-full justify-start gap-2 px-2 text-xs font-normal text-muted-foreground',
            view === 'components' && 'bg-accent text-accent-foreground'
          )}
          onClick={() => useUi.getState().setView(view === 'components' ? 'chat' : 'components')}
        >
          <Boxes className="size-3.5" />
          Componentes
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={view === 'instructions'}
          className={cn(
            'h-7 w-full justify-start gap-2 px-2 text-xs font-normal text-muted-foreground',
            view === 'instructions' && 'bg-accent text-accent-foreground'
          )}
          onClick={() =>
            useUi.getState().setView(view === 'instructions' ? 'chat' : 'instructions')
          }
        >
          <ScrollText className="size-3.5" />
          Instruções
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-start gap-2 px-2 text-xs font-normal text-muted-foreground"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="size-3.5" />
          Configurações
        </Button>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </aside>
  )
}
