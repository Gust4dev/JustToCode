import { useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { call } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { Textarea } from '@renderer/components/ui/textarea'
import { errorMessage, isUnknownMethod, useProjects } from '@renderer/features/projects/store'
import { ruleSaveParams, suggestionsToPatch } from './logic'
import type { RuleDraft } from './rules'

function RuleForm({
  chatId,
  initial,
  onCancel,
  onDone
}: {
  chatId: string
  initial: RuleDraft
  onCancel(): void
  onDone(): void
}): React.JSX.Element {
  const [text, setText] = useState(initial.ruleText)
  const [chosen, setChosen] = useState<Set<number>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const picked = initial.suggestions.filter((_, i) => chosen.has(i))
  const canSave = !saving && (text.trim().length > 0 || picked.length > 0)

  const toggle = (i: number): void =>
    setChosen((cur) => {
      const next = new Set(cur)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      if (text.trim()) await call('instructions.save', ruleSaveParams(chatId, text))
      const patch = suggestionsToPatch(picked)
      if (patch) await useProjects.getState().updateChat(chatId, patch)
      toast.success(
        text.trim()
          ? picked.length
            ? 'Regra salva e ajustes aplicados.'
            : 'Regra salva para este chat.'
          : 'Ajustes aplicados.'
      )
      onDone()
    } catch (e) {
      toast.error(
        isUnknownMethod(e)
          ? 'O agent-host ainda não suporta regras.'
          : `Não foi possível salvar: ${errorMessage(e)}`
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="rule-text">Regra</Label>
        <Textarea
          id="rule-text"
          value={text}
          autoFocus
          className="max-h-[40vh] min-h-24 text-sm"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void save()
            }
          }}
        />
      </div>
      {initial.suggestions.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">
            Ajustes sugeridos (clique para aplicar junto):
          </p>
          <div className="flex flex-wrap gap-1.5">
            {initial.suggestions.map((s, i) => {
              const on = chosen.has(i)
              return (
                <button
                  key={`${s.key}-${i}`}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(i)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                    on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'bg-background text-foreground hover:bg-accent'
                  )}
                >
                  {on ? <Check className="size-3" /> : <Plus className="size-3" />}
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
        <Button size="sm" disabled={!canSave} onClick={() => void save()}>
          {text.trim() ? 'Salvar regra' : 'Aplicar ajustes'}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** Diálogo do `/regra`: texto editável + chips de ajustes confirmados um a um. */
export function RuleDialog({
  chatId,
  draft,
  onOpenChange,
  onSaved
}: {
  chatId: string
  /** null = fechado. */
  draft: RuleDraft | null
  onOpenChange(open: boolean): void
  onSaved(): void
}): React.JSX.Element {
  return (
    <Dialog open={draft !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nova regra do chat</DialogTitle>
          <DialogDescription>
            A regra vale sempre neste chat. Revise o texto e escolha os ajustes que quer aplicar.
          </DialogDescription>
        </DialogHeader>
        {draft && (
          <RuleForm
            chatId={chatId}
            initial={draft}
            onCancel={() => onOpenChange(false)}
            onDone={() => {
              onSaved()
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
