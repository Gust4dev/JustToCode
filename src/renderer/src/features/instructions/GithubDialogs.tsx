import { useMemo, useState } from 'react'
import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  InstallPreview,
  InstallPreviewItem,
  Instruction,
  InstructionScope
} from '@shared/domain'
import { call } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
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
import { KIND_LABEL } from './logic'
import {
  defaultTargetId,
  diffStats,
  initialSelection,
  installParams,
  isBlocked,
  previewItemFor,
  scopeOptions,
  selectAll,
  sourceShort,
  toggleSelection,
  updateDiff,
  updateParams,
  type ScopeTargetContext
} from './libraryLogic'
import { libraryErrorMessage } from './libraryErrors'
import { DiffView, PreviewContent, SuspiciousList } from './PreviewContent'

function ItemLine({
  item,
  checked,
  active,
  onCheck,
  onSelect
}: {
  item: InstallPreviewItem
  checked: boolean
  active: boolean
  onCheck(on: boolean): void
  onSelect(): void
}): React.JSX.Element {
  const blocked = isBlocked(item)
  return (
    <li
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent/60',
        active && 'bg-accent',
        blocked && 'bg-destructive/5'
      )}
      onClick={onSelect}
    >
      <Checkbox
        checked={checked}
        disabled={blocked}
        aria-label={`Instalar ${item.name}`}
        className="mt-0.5"
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={(v) => onCheck(v === true)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono font-medium">
            {item.kind === 'command' ? `/${item.name}` : item.name}
          </span>
          <Badge variant="outline" className="px-1 py-0 text-[10px]">
            {KIND_LABEL[item.kind]}
          </Badge>
          {blocked && (
            <Badge variant="destructive" className="gap-0.5 px-1 py-0 text-[10px]">
              <AlertTriangle className="size-2.5" />
              {item.suspicious.length} suspeito(s)
            </Badge>
          )}
        </div>
        <p className="truncate text-[11px] text-muted-foreground" title={item.path}>
          {item.path}
        </p>
      </div>
    </li>
  )
}

/** Diálogo "Instalar do GitHub": URL → preview marcável → escopo → instalar. */
export function GithubInstallDialog({
  open,
  onOpenChange,
  targets,
  onInstalled
}: {
  open: boolean
  onOpenChange(open: boolean): void
  targets: ScopeTargetContext
  onInstalled(items: Instruction[]): void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Instalar do GitHub</DialogTitle>
          <DialogDescription>
            Cole a URL de um repositório, pasta (tree) ou arquivo (blob). Revise o conteúdo antes de
            instalar.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <InstallForm
            targets={targets}
            onCancel={() => onOpenChange(false)}
            onInstalled={(items) => {
              onInstalled(items)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function InstallForm({
  targets,
  onCancel,
  onInstalled
}: {
  targets: ScopeTargetContext
  onCancel(): void
  onInstalled(items: Instruction[]): void
}): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [preview, setPreview] = useState<InstallPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | null>(null)
  const scopes = useMemo(() => scopeOptions(targets), [targets])
  const [scope, setScope] = useState<InstructionScope>(targets.project ? 'project' : 'global')
  const [scopeId, setScopeId] = useState<string | null>(() => defaultTargetId(scope, targets))
  const targetList = scopes.find((o) => o.scope === scope)?.targets ?? []

  const load = async (): Promise<void> => {
    const u = url.trim()
    if (!u) return
    setLoading(true)
    try {
      const p = await call('library.previewGithub', { url: u })
      setPreview(p)
      setSelected(initialSelection(p))
      setActive(p.items[0]?.path ?? null)
      if (p.items.length === 0) toast.info('Nenhuma regra, comando ou skill encontrado nessa URL.')
    } catch (e) {
      setPreview(null)
      toast.error(libraryErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const params = preview ? installParams(preview, selected, scope, scopeId) : null
  const install = async (): Promise<void> => {
    if (!params) return
    setInstalling(true)
    try {
      const items = await call('library.installGithub', params)
      toast.success(items.length === 1 ? '1 item instalado.' : `${items.length} itens instalados.`)
      onInstalled(items)
    } catch (e) {
      toast.error(libraryErrorMessage(e))
    } finally {
      setInstalling(false)
    }
  }

  const activeItem = preview?.items.find((i) => i.path === active) ?? null
  const blockedCount = preview?.items.filter(isBlocked).length ?? 0
  const selectable = (preview?.items.length ?? 0) - blockedCount

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void load()
        }}
      >
        <Input
          value={url}
          autoFocus
          placeholder="https://github.com/dono/repo/tree/main/skills"
          aria-label="URL do GitHub"
          className="text-xs md:text-xs"
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={loading || !url.trim()}>
          {loading && <Loader2 className="animate-spin" />}
          Ver conteúdo
        </Button>
      </form>

      {preview && (
        <>
          <p className="text-[11px] text-muted-foreground">
            {preview.ref} · {preview.sha.slice(0, 7)} · {preview.items.length} item(ns)
            {blockedCount > 0 && (
              <span className="text-destructive"> · {blockedCount} bloqueado(s) por suspeitos</span>
            )}
          </p>
          {preview.items.length > 0 && (
            <div className="grid min-h-0 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div className="flex min-h-0 flex-col gap-1">
                <div className="flex items-center gap-2 px-2 text-[11px] text-muted-foreground">
                  <Checkbox
                    checked={
                      selectable > 0 && selected.size === selectable
                        ? true
                        : selected.size > 0
                          ? 'indeterminate'
                          : false
                    }
                    disabled={selectable === 0}
                    aria-label="Marcar todos"
                    onCheckedChange={(v) => setSelected(selectAll(preview, v === true))}
                  />
                  {selected.size} de {selectable} marcado(s)
                </div>
                <ul className="max-h-[45vh] overflow-auto">
                  {preview.items.map((i) => (
                    <ItemLine
                      key={i.path}
                      item={i}
                      checked={selected.has(i.path)}
                      active={i.path === active}
                      onCheck={(on) => setSelected((s) => toggleSelection(s, i, on))}
                      onSelect={() => setActive(i.path)}
                    />
                  ))}
                </ul>
              </div>
              <div className="flex min-h-0 flex-col gap-2">
                {activeItem ? (
                  <>
                    <SuspiciousList item={activeItem} />
                    <PreviewContent item={activeItem} className="max-h-[45vh]" />
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">Escolha um item para ver.</p>
                )}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label>Instalar no escopo</Label>
              <Select
                value={scope}
                onValueChange={(v) => {
                  const s = v as InstructionScope
                  setScope(s)
                  setScopeId(defaultTargetId(s, targets, scopeId))
                }}
              >
                <SelectTrigger size="sm" className="w-32 text-xs" aria-label="Escopo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((o) => (
                    <SelectItem key={o.scope} value={o.scope}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {scope !== 'global' && (
              <div className="grid min-w-0 flex-1 gap-1.5">
                <Label>Alvo</Label>
                <Select value={scopeId ?? undefined} onValueChange={setScopeId}>
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
          </div>
        </>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!params || installing}
          onClick={() => void install()}
        >
          {installing ? <Loader2 className="animate-spin" /> : <Download />}
          Instalar {params ? params.paths.length : 0}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** Resultado de "Verificar atualização" com diff e botão de atualizar. */
export function GithubUpdateDialog({
  target,
  onOpenChange,
  onUpdated
}: {
  /** null = fechado. */
  target: { item: Instruction; preview: InstallPreview } | null
  onOpenChange(open: boolean): void
  onUpdated(items: Instruction[]): void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const pItem = target ? previewItemFor(target.item, target.preview) : null
  const diff = useMemo(
    () => (target && pItem ? updateDiff(target.item, pItem) : []),
    [target, pItem]
  )
  const stats = diffStats(diff)
  const params = target && pItem ? updateParams(target.item, target.preview, pItem) : null

  const update = async (): Promise<void> => {
    if (!params) return
    setBusy(true)
    try {
      const items = await call('library.installGithub', params)
      toast.success('Item atualizado.')
      onUpdated(items)
      onOpenChange(false)
    } catch (e) {
      toast.error(libraryErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        {target && (
          <>
            <DialogHeader>
              <DialogTitle>Atualização disponível: {target.item.name}</DialogTitle>
              <DialogDescription>
                {sourceShort(target.item)} → {target.preview.sha.slice(0, 7)} · +{stats.added} −
                {stats.removed} linha(s)
              </DialogDescription>
            </DialogHeader>
            {pItem ? (
              <>
                <SuspiciousList item={pItem} />
                <DiffView diff={diff} className="max-h-[55vh]" />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                O item não foi encontrado na versão nova do repositório.
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Fechar
              </Button>
              <Button size="sm" disabled={!params || busy} onClick={() => void update()}>
                {busy ? <Loader2 className="animate-spin" /> : <Download />}
                Atualizar
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
