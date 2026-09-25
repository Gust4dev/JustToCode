import { useState } from 'react'
import { toast } from 'sonner'
import type {
  Instruction,
  InstructionKind,
  InstructionScope,
  InstructionTrigger
} from '@shared/domain'
import { call } from '@renderer/lib/host'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { Textarea } from '@renderer/components/ui/textarea'
import { Markdown } from '@renderer/features/chat/Markdown'
import { errorMessage, isUnknownMethod } from '@renderer/features/projects/store'
import {
  changeDraftKind,
  changeDraftScope,
  scopeOptions,
  type ScopeTargetContext
} from './libraryLogic'
import {
  KIND_LABEL,
  KIND_ORDER,
  SCOPE_LABEL,
  TRIGGER_LABEL,
  parseGlobs,
  saveParams,
  validateDraft,
  type InstructionDraft
} from './logic'

const TRIGGERS: InstructionTrigger[] = ['always', 'glob', 'model', 'manual']

function EditForm({
  initial,
  targets,
  onCancel,
  onSaved
}: {
  initial: InstructionDraft
  targets?: ScopeTargetContext
  onCancel(): void
  onSaved(i: Instruction): void
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  const [globsText, setGlobsText] = useState(initial.globs.join(', '))
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const isMemory = draft.kind === 'memory'
  const creating = !draft.id
  const scopes = targets ? scopeOptions(targets) : null
  // Mantém o escopo atual na lista mesmo se o projeto não o oferecer.
  const scopeList =
    scopes && !scopes.some((o) => o.scope === draft.scope)
      ? [...scopes, { scope: draft.scope, label: SCOPE_LABEL[draft.scope], targets: [] }]
      : scopes
  const targetList = scopeList?.find((o) => o.scope === draft.scope)?.targets ?? []
  const set = <K extends keyof InstructionDraft>(k: K, v: InstructionDraft[K]): void =>
    setDraft((d) => ({ ...d, [k]: v }))

  const save = async (): Promise<void> => {
    const full = { ...draft, globs: parseGlobs(globsText) }
    const err = validateDraft(full)
    if (err) {
      toast.error(err)
      return
    }
    setSaving(true)
    try {
      onSaved(await call('instructions.save', saveParams(full)))
    } catch (e) {
      toast.error(
        isUnknownMethod(e)
          ? 'O agent-host ainda não suporta salvar instruções.'
          : (e as { code?: unknown } | null)?.code === 'READONLY'
            ? 'Este item é somente leitura.'
            : `Não foi possível salvar: ${errorMessage(e)}`
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="flex min-h-0 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {creating && (
        <div className="grid gap-1.5">
          <Label>Tipo</Label>
          <Select
            value={draft.kind}
            onValueChange={(v) => setDraft((d) => changeDraftKind(d, v as InstructionKind))}
          >
            <SelectTrigger size="sm" className="w-56 text-xs" aria-label="Tipo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_ORDER.map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="inst-name">
          {isMemory ? 'Título' : draft.kind === 'command' ? 'Comando (/nome)' : 'Nome'}
        </Label>
        <Input
          id="inst-name"
          value={draft.name}
          autoFocus
          onChange={(e) => set('name', e.target.value)}
        />
      </div>
      {!isMemory && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="inst-desc">Descrição</Label>
            <Input
              id="inst-desc"
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Gatilho</Label>
            <Select
              value={draft.trigger}
              onValueChange={(v) => set('trigger', v as InstructionTrigger)}
            >
              <SelectTrigger size="sm" className="w-56 text-xs" aria-label="Gatilho">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {draft.trigger === 'glob' && (
            <div className="grid gap-1.5">
              <Label htmlFor="inst-globs">Arquivos (padrões glob, separados por vírgula)</Label>
              <Input
                id="inst-globs"
                value={globsText}
                placeholder="src/**/*.ts, *.md"
                onChange={(e) => setGlobsText(e.target.value)}
              />
            </div>
          )}
        </>
      )}
      {(scopeList || !isMemory) && (
        <div className="flex flex-wrap items-end gap-3">
          {scopeList && targets && (
            <>
              <div className="grid gap-1.5">
                <Label>Escopo</Label>
                <Select
                  value={draft.scope}
                  onValueChange={(v) =>
                    setDraft((d) => changeDraftScope(d, v as InstructionScope, targets))
                  }
                >
                  <SelectTrigger size="sm" className="w-32 text-xs" aria-label="Escopo">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeList.map((o) => (
                      <SelectItem key={o.scope} value={o.scope}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {draft.scope !== 'global' && (
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <Label>Alvo</Label>
                  <Select
                    value={draft.scopeId ?? undefined}
                    onValueChange={(v) => set('scopeId', v)}
                    disabled={targetList.length === 0}
                  >
                    <SelectTrigger size="sm" className="w-full min-w-40 text-xs" aria-label="Alvo">
                      <SelectValue placeholder="Sem alvo disponível" />
                    </SelectTrigger>
                    <SelectContent>
                      {targetList.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          )}
          {!isMemory && (
            <div className="grid gap-1.5">
              <Label>Formato</Label>
              <Select
                value={draft.format}
                onValueChange={(v) => set('format', v === 'toml' ? 'toml' : 'md')}
              >
                <SelectTrigger size="sm" className="w-28 text-xs" aria-label="Formato">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="md">.md</SelectItem>
                  <SelectItem value="toml">.toml</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
      <div className="grid min-h-0 gap-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor="inst-body">Conteúdo</Label>
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v === 'preview' ? 'preview' : 'edit')}
            className="ml-auto"
          >
            <TabsList className="h-7">
              <TabsTrigger value="edit" className="text-xs">
                Editar
              </TabsTrigger>
              <TabsTrigger value="preview" className="text-xs">
                Pré-visualizar
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {tab === 'edit' ? (
          <Textarea
            id="inst-body"
            value={draft.body}
            className="max-h-[40vh] min-h-40 font-mono text-xs"
            onChange={(e) => set('body', e.target.value)}
          />
        ) : (
          <div className="max-h-[40vh] min-h-40 overflow-auto rounded-md border px-3 py-2">
            {draft.body.trim() ? (
              <Markdown text={draft.body} />
            ) : (
              <p className="text-xs text-muted-foreground">Nada para mostrar.</p>
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          Salvar
        </Button>
      </DialogFooter>
    </form>
  )
}

/**
 * Editor de instruções do app. Com `draft.id` edita; sem id cria. Com `targets`, permite trocar
 * escopo e alvo (projeto/grupo/chat do projeto atual).
 */
export function InstructionEditDialog({
  draft,
  targets,
  onOpenChange,
  onSaved
}: {
  /** null = fechado. */
  draft: InstructionDraft | null
  targets?: ScopeTargetContext
  onOpenChange(open: boolean): void
  onSaved(i: Instruction): void
}): React.JSX.Element {
  return (
    <Dialog open={draft !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        {draft && (
          <>
            <DialogHeader>
              <DialogTitle>
                {draft.id ? `Editar ${KIND_LABEL[draft.kind]}` : 'Nova instrução'}
              </DialogTitle>
              <DialogDescription>
                {targets
                  ? 'Defina tipo, gatilho, escopo e conteúdo.'
                  : `Escopo: ${SCOPE_LABEL[draft.scope]}`}
              </DialogDescription>
            </DialogHeader>
            <EditForm
              key={draft.id ?? 'new'}
              initial={draft}
              targets={targets}
              onCancel={() => onOpenChange(false)}
              onSaved={(i) => {
                onSaved(i)
                onOpenChange(false)
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
