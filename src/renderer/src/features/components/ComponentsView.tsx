import { X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { cn } from '@renderer/lib/utils'
import { useUi } from '@renderer/stores/ui'
import { useComponents, type ComponentsTab } from './componentsStore'
import { dotClass, statusDot } from './format'
import { LlamaTab } from './LlamaTab'
import { ModelsTab } from './ModelsTab'
import { RouterTab } from './RouterTab'

function Dot({ id }: { id: '9router' | 'llama' }): React.JSX.Element {
  const s = useComponents((st) => st.statuses[id])
  return <span aria-hidden className={cn('size-1.5 rounded-full', dotClass(statusDot(s)))} />
}

/** Tela Componentes (área central): 9router, llama.cpp e modelos GGUF. */
export function ComponentsView(): React.JSX.Element {
  const tab = useComponents((s) => s.tab)
  const change = (v: string): void => useComponents.getState().setTab(v as ComponentsTab)
  return (
    <Tabs value={tab} onValueChange={change} className="flex h-full flex-col gap-0">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <h2 className="text-sm font-medium">Componentes</h2>
        <TabsList className="h-8">
          <TabsTrigger value="9router" className="gap-1.5 text-xs">
            <Dot id="9router" />
            9router
          </TabsTrigger>
          <TabsTrigger value="llama" className="gap-1.5 text-xs">
            <Dot id="llama" />
            llama.cpp
          </TabsTrigger>
          <TabsTrigger value="models" className="text-xs">
            Modelos
          </TabsTrigger>
        </TabsList>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label="Fechar componentes"
          title="Voltar para a conversa"
          onClick={() => useUi.getState().setView('chat')}
        >
          <X />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl p-4">
          <TabsContent value="9router">
            <RouterTab />
          </TabsContent>
          <TabsContent value="llama">
            <LlamaTab />
          </TabsContent>
          <TabsContent value="models">
            <ModelsTab />
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  )
}
