import { useState, useSyncExternalStore } from 'react'
import { Editor } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { toast } from 'sonner'
import { Check, PencilLine, Save, Undo2 } from 'lucide-react'
import type { RevertConflict } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { errorMessage } from '@renderer/features/projects/store'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { languageForPath } from './monaco'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const subscribeDark = (cb: () => void): (() => void) => {
  darkQuery.addEventListener('change', cb)
  return () => darkQuery.removeEventListener('change', cb)
}
const useSystemDark = (): boolean => useSyncExternalStore(subscribeDark, () => darkQuery.matches)

const BASE_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  overviewRulerLanes: 0,
  fontSize: 12,
  lineNumbersMinChars: 3,
  wordWrap: 'off'
}
const READ_ONLY = { ...BASE_OPTIONS, readOnly: true, domReadOnly: true }

const MARKERS = /^(<{7}|>{7}|={7}|\|{7})( |$)/m

export interface ConflictTarget {
  path: string
  chatId: string
  /** null = conflito sem conteúdo (binário ou sem blob): só "Manter atual" / "Aplicar reversão". */
  conflict: RevertConflict | null
  message: string | null
}

type Choice = 'keep-current' | 'apply-revert' | 'manual'

export function ConflictDialog({
  projectId,
  target,
  onClose,
  onResolved
}: {
  projectId: string
  target: ConflictTarget
  onClose(): void
  onResolved(): void
}): React.JSX.Element {
  const dark = useSystemDark()
  const [manual, setManual] = useState(false)
  const [draft, setDraft] = useState(target.conflict?.merged ?? '')
  const [busy, setBusy] = useState(false)
  const language = languageForPath(target.path)
  const theme = dark ? 'vs-dark' : 'light'

  const resolve = async (choice: Choice): Promise<void> => {
    setBusy(true)
    try {
      await call('changes.resolveConflict', {
        projectId,
        chatId: target.chatId,
        path: target.path,
        choice,
        ...(choice === 'manual' ? { content: draft } : {})
      })
      toast.success(
        choice === 'keep-current'
          ? 'Mantido o conteúdo atual'
          : choice === 'apply-revert'
            ? 'Reversão aplicada'
            : 'Resolução manual salva',
        { description: target.path }
      )
      onResolved()
    } catch (e) {
      toast.error(`Não foi possível resolver o conflito: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const c = target.conflict
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Conflito ao reverter</DialogTitle>
          <DialogDescription className="break-all">
            {target.path} mudou depois deste chat.
            {target.message ? ` ${target.message}` : ''}
          </DialogDescription>
        </DialogHeader>

        {c &&
          (manual ? (
            <div className="flex min-h-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Editar o resultado
                {MARKERS.test(draft) && (
                  <span className="ml-2 text-amber-600 dark:text-amber-400">
                    ainda há marcadores de conflito
                  </span>
                )}
              </span>
              <div className="h-[60vh] overflow-hidden rounded-md border">
                <Editor
                  height="100%"
                  defaultValue={c.merged}
                  language={language}
                  theme={theme}
                  options={BASE_OPTIONS}
                  onChange={(v) => setDraft(v ?? '')}
                />
              </div>
            </div>
          ) : (
            <div className="grid min-h-0 grid-cols-3 gap-2">
              <Column title="Atual" value={c.current} language={language} theme={theme} />
              <Column title="Reverter para" value={c.reverted} language={language} theme={theme} />
              <Column
                title="Resultado (com marcadores)"
                value={c.merged}
                language={language}
                theme={theme}
              />
            </div>
          ))}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <div className="flex flex-wrap gap-2">
            {manual ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setManual(false)}
                >
                  Voltar
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void resolve('manual')}>
                  <Save />
                  Salvar
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title="Não reverte; marca as mudanças deste chat como revisadas"
                  onClick={() => void resolve('keep-current')}
                >
                  <Check />
                  Manter atual
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title="Grava o conteúdo de antes deste chat, descartando o que veio depois"
                  onClick={() => void resolve('apply-revert')}
                >
                  <Undo2 />
                  Aplicar reversão
                </Button>
                {c && (
                  <Button size="sm" disabled={busy} onClick={() => setManual(true)}>
                    <PencilLine />
                    Editar manualmente
                  </Button>
                )}
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Column({
  title,
  value,
  language,
  theme
}: {
  title: string
  value: string
  language: string
  theme: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <div className="h-[55vh] overflow-hidden rounded-md border">
        <Editor height="100%" value={value} language={language} theme={theme} options={READ_ONLY} />
      </div>
    </div>
  )
}
