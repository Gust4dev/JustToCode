import { useState } from 'react'
import { PackagePlus, Plus } from 'lucide-react'
import type { Instruction, InstructionKind } from '@shared/domain'
import { Button } from '@renderer/components/ui/button'
import { GithubInstallDialog } from './GithubDialogs'
import { newDraft, type ScopeTargetContext } from './libraryLogic'
import type { InstructionDraft } from './logic'

/** O que a tela Instruções passa para as ações da barra (ponto de extensão). */
export interface InstructionsToolbarContext {
  /** Aba atual. */
  kind: InstructionKind
  /** Projeto selecionado (null = só globais). */
  projectId: string | null
  /** Chat selecionado (null = nenhum). */
  chatId: string | null
  /** Recarrega a lista. */
  reload(): void
  /** Abre o editor com um rascunho (sem id = criar). */
  edit(draft: InstructionDraft): void
  /** Itens carregados (todas as abas). */
  items: Instruction[]
  /** Projeto/grupos/chats disponíveis como alvo de escopo. */
  targets: ScopeTargetContext
}

/** Ações da barra da tela Instruções: "Nova" e "Instalar do GitHub". */
export function InstructionsActions({
  ctx
}: {
  ctx: InstructionsToolbarContext
}): React.JSX.Element {
  const [installing, setInstalling] = useState(false)
  return (
    <>
      <Button variant="outline" size="xs" onClick={() => setInstalling(true)}>
        <PackagePlus />
        Instalar do GitHub
      </Button>
      <Button size="xs" onClick={() => ctx.edit(newDraft(ctx.kind, ctx.targets))}>
        <Plus />
        Nova
      </Button>
      <GithubInstallDialog
        open={installing}
        onOpenChange={setInstalling}
        targets={ctx.targets}
        onInstalled={() => ctx.reload()}
      />
    </>
  )
}
