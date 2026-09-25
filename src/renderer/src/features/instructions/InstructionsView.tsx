import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileOutput,
  Loader2,
  Pencil,
  Puzzle,
  RefreshCcw,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  Chat,
  InstallPreview,
  Instruction,
  InstructionKind,
  InstructionScope
} from '@shared/domain'
import { call } from '@renderer/lib/host'
import { useEngineEvent } from '@renderer/lib/engineEvents'
import { cn } from '@renderer/lib/utils'
import { useUi } from '@renderer/stores/ui'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { ConfirmDialog } from '@renderer/features/projects/ConfirmDialog'
import { errorMessage, isUnknownMethod, useProjects } from '@renderer/features/projects/store'
import { GithubUpdateDialog } from './GithubDialogs'
import { libraryErrorMessage } from './libraryErrors'
import { InstructionEditDialog } from './InstructionEditDialog'
import { InstructionsActions, type InstructionsToolbarContext } from './InstructionsActions'
import {
  KIND_ORDER,
  KIND_TAB_LABEL,
  SCOPE_LABEL,
  TRIGGER_LABEL,
  countByKind,
  draftFrom,
  filterInstructions,
  isEditable,
  mergeById,
  sourceLabel,
  sourceTitle,
  thirdPartyOrigins,
  visibleInstructions,
  type InstructionContextIds,
  type InstructionDraft,
  type ScopeFilter
} from './logic'
import {
  batchToggleTargets,
  exportErrorMessage,
  groupByPlugin,
  groupToggleState,
  type PluginGroup,
  type ScopeTargetContext
} from './libraryLogic'

const NO_CHATS: Chat[] = []
const SCOPE_FILTERS: ScopeFilter[] = ['all', 'global', 'project', 'group', 'chat']

interface ListState {
  items: Instruction[]
  error: string | null
  unsupported: boolean
  /** Chave (projeto/chat/recarga) do último carregamento concluído. */
  key: string | null
}

/** Carrega `instructions.list` (tudo do app + o contexto do projeto/chat) e mescla por id. */
function useInstructionItems(
  projectId: string | null,
  chatId: string | null
): ListState & {
  loading: boolean
  reload(): void
  upsert(i: Instruction): void
  remove(id: string): void
} {
  const [state, setState] = useState<ListState>({
    items: [],
    error: null,
    unsupported: false,
    key: null
  })
  const [tick, setTick] = useState(0)
  const key = `${projectId}:${chatId}:${tick}`

  useEffect(() => {
    let alive = true
    const ctxParams = projectId ? (chatId ? { projectId, chatId } : { projectId }) : null
    Promise.all([
      call('instructions.list', {}),
      ctxParams
        ? call('instructions.list', ctxParams).catch((e: unknown) => {
            // Chat de outro projeto/removido: fica só com o projeto.
            if (projectId && chatId && !isUnknownMethod(e))
              return call('instructions.list', { projectId })
            throw e
          })
        : Promise.resolve([] as Instruction[])
    ])
      .then(([all, ctx]) => {
        if (alive) setState({ items: mergeById(all, ctx), error: null, unsupported: false, key })
      })
      .catch((e: unknown) => {
        if (!alive) return
        setState({
          items: [],
          key,
          error: isUnknownMethod(e) ? null : errorMessage(e),
          unsupported: isUnknownMethod(e)
        })
      })
    return () => {
      alive = false
    }
  }, [projectId, chatId, key])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  const upsert = useCallback(
    (i: Instruction) =>
      setState((s) => ({
        ...s,
        items: s.items.some((x) => x.id === i.id)
          ? s.items.map((x) => (x.id === i.id ? i : x))
          : [...s.items, i]
      })),
    []
  )
  const remove = useCallback(
    (id: string) => setState((s) => ({ ...s, items: s.items.filter((x) => x.id !== id) })),
    []
  )
  return { ...state, loading: state.key !== key, reload, upsert, remove }
}

function useContextIds(
  projectId: string | null,
  chatId: string | null
): {
  ids: InstructionContextIds | null
  targetName(scope: InstructionScope, scopeId: string | null): string | null
  targets: ScopeTargetContext
} {
  const chats = useProjects((s) => (projectId ? (s.chats[projectId] ?? NO_CHATS) : NO_CHATS))
  const children = useProjects((s) => s.children)
  const groups = useProjects((s) => (projectId ? s.groups[projectId] : undefined))
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId) ?? null)
  return useMemo(() => {
    const chatById = new Map<string, Chat>()
    for (const c of chats) {
      chatById.set(c.id, c)
      for (const k of children[c.id] ?? []) chatById.set(k.id, k)
    }
    const groupById = new Map((groups ?? []).map((g) => [g.id, g]))
    const ids = projectId
      ? {
          projectId,
          groupIds: new Set(groupById.keys()),
          chatIds: new Set(chatById.keys())
        }
      : null
    const targetName = (scope: InstructionScope, scopeId: string | null): string | null => {
      if (!scopeId) return null
      if (scope === 'project') return scopeId === projectId ? (project?.name ?? null) : null
      if (scope === 'group') return groupById.get(scopeId)?.name ?? null
      if (scope === 'chat') return chatById.get(scopeId)?.title ?? null
      return null
    }
    const targets: ScopeTargetContext = {
      project: project ? { id: project.id, name: project.name } : null,
      groups: (groups ?? []).map((g) => ({ id: g.id, name: g.name })),
      chats: chats.map((c) => ({ id: c.id, title: c.title })),
      chatId
    }
    return { ids, targetName, targets }
  }, [chats, children, groups, project, projectId, chatId])
}

function ItemRow({
  item,
  targetName,
  chatTitle,
  onToggle,
  onEdit,
  onDelete,
  onExport,
  onCheckUpdate,
  checking = false
}: {
  item: Instruction
  targetName: string | null
  chatTitle: string | null
  onToggle(on: boolean): void
  onEdit(): void
  onDelete(): void
  /** Presente quando dá para exportar (item do app + projeto aberto). */
  onExport?(): void
  /** Presente em itens instalados do GitHub. */
  onCheckUpdate?(): void
  checking?: boolean
}): React.JSX.Element {
  const editable = isEditable(item)
  const isMemory = item.kind === 'memory'
  const label = item.kind === 'command' ? `/${item.name}` : item.name
  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5',
        !item.enabled && 'opacity-60'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={cn('truncate text-sm font-medium', !isMemory && 'font-mono')}
            title={label}
          >
            {label}
          </span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {SCOPE_LABEL[item.scope]}
            {targetName && `: ${targetName}`}
          </Badge>
          {!isMemory && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
              {TRIGGER_LABEL[item.trigger]}
              {item.trigger === 'glob' && item.globs.length > 0 && ` · ${item.globs.join(', ')}`}
            </Badge>
          )}
          <span
            className="truncate text-[11px] text-muted-foreground"
            title={sourceTitle(item.source)}
          >
            {sourceLabel(item.source)}
          </span>
        </div>
        {item.description && !isMemory && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
        )}
        {isMemory && (
          <>
            <p className="mt-1 line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">
              {item.body}
            </p>
            {item.origin && (
              <p className="mt-1 text-[11px] text-muted-foreground/80">
                salva em {chatTitle ? `“${chatTitle}”` : 'um chat'}
                {item.origin.thirdParty.length > 0 &&
                  ` · influenciada por ${item.origin.thirdParty.length} instrução(ões) de terceiros`}
              </p>
            )}
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onCheckUpdate && (
          <Button
            variant="ghost"
            size="xs"
            disabled={checking}
            title="Verificar se há versão nova no GitHub"
            onClick={onCheckUpdate}
          >
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
            Verificar atualização
          </Button>
        )}
        {onExport && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Exportar para o repo"
            title="Exportar para o repo (.justtocode/)"
            onClick={onExport}
          >
            <FileOutput />
          </Button>
        )}
        {editable && (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Editar"
              title="Editar"
              onClick={onEdit}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Excluir"
              title="Excluir"
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </>
        )}
        <Switch
          checked={item.enabled}
          onCheckedChange={onToggle}
          aria-label={item.enabled ? 'Desligar' : 'Ligar'}
          className="ml-1 scale-90"
        />
      </div>
    </li>
  )
}

function PluginGroupSection({
  group,
  onToggleAll,
  children
}: {
  group: PluginGroup
  onToggleAll(on: boolean): void
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const state = groupToggleState(group)
  return (
    <li className="rounded-lg border bg-card/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <Puzzle className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{group.plugin}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            @{group.marketplace} · {group.enabled}/{group.items.length} ligados
          </span>
        </button>
        <Switch
          checked={state !== 'off'}
          onCheckedChange={(on) => onToggleAll(state === 'mixed' ? true : on)}
          aria-label={`Ligar/desligar tudo de ${group.plugin}`}
          title={state === 'mixed' ? 'Parte ligada: ligar tudo' : undefined}
          className={cn('scale-90', state === 'mixed' && 'opacity-60')}
        />
      </div>
      {open && <ul className="flex flex-col gap-2 border-t p-2">{children}</ul>}
    </li>
  )
}

function ThirdPartyPanel({
  memories,
  all,
  onDeleted
}: {
  memories: Instruction[]
  all: Instruction[]
  onDeleted(): void
}): React.JSX.Element | null {
  const origins = useMemo(() => thirdPartyOrigins(memories, all), [memories, all])
  const [confirm, setConfirm] = useState<{ id: string; label: string; count: number } | null>(null)
  if (origins.length === 0) return null

  const run = (id: string): void => {
    call('memory.deleteByOrigin', { thirdPartyId: id })
      .then((r) => {
        toast.success(r.deleted === 1 ? '1 memória apagada.' : `${r.deleted} memórias apagadas.`)
        onDeleted()
      })
      .catch((e: unknown) =>
        toast.error(
          isUnknownMethod(e)
            ? 'O agent-host ainda não suporta apagar memórias por origem.'
            : `Não foi possível apagar: ${errorMessage(e)}`
        )
      )
  }

  return (
    <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-xs font-medium">Memórias influenciadas por instruções de terceiros</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {origins.map((o) => (
          <li key={o.id} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate" title={o.id}>
              {o.label}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {o.count} {o.count === 1 ? 'memória' : 'memórias'}
            </span>
            <Button variant="outline" size="xs" className="shrink-0" onClick={() => setConfirm(o)}>
              <Trash2 />
              Apagar tudo desta origem
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Apagar memórias desta origem?"
        description={
          confirm
            ? `As ${confirm.count} memória(s) salvas sob influência de “${confirm.label}” serão apagadas.`
            : ''
        }
        confirmLabel="Apagar"
        onConfirm={() => confirm && run(confirm.id)}
      />
    </div>
  )
}

/** Tela Instruções (área central): regras, comandos, skills e memórias. */
export function InstructionsView(): React.JSX.Element {
  const projectId = useUi((s) => s.projectId)
  const chatId = useUi((s) => s.chatId)
  const [kind, setKind] = useState<InstructionKind>('rule')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<InstructionDraft | null>(null)
  const [deleting, setDeleting] = useState<Instruction | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const [update, setUpdate] = useState<{ item: Instruction; preview: InstallPreview } | null>(null)
  const list = useInstructionItems(projectId, chatId)
  const { ids, targetName, targets } = useContextIds(projectId, chatId)
  const { reload, upsert, remove } = list

  // Memórias novas aparecem sem recarregar a tela.
  useEngineEvent((e) => {
    if (e.type === 'memory_saved') upsert(e.instruction)
  })

  const visible = useMemo(() => visibleInstructions(list.items, ids), [list.items, ids])
  const counts = useMemo(() => countByKind(visible), [visible])
  const shown = useMemo(
    () => filterInstructions(visible, { kind, scope, query }),
    [visible, kind, scope, query]
  )
  const memories = useMemo(() => visible.filter((i) => i.kind === 'memory'), [visible])
  const grouped = useMemo(
    () =>
      kind === 'skill' || kind === 'command' ? groupByPlugin(shown) : { groups: [], rest: shown },
    [kind, shown]
  )

  const toggle = (item: Instruction, on: boolean): void => {
    upsert({ ...item, enabled: on })
    call('instructions.setEnabled', { id: item.id, enabled: on })
      .then(upsert)
      .catch((e: unknown) => {
        upsert(item)
        toast.error(
          isUnknownMethod(e)
            ? 'O agent-host ainda não suporta ligar/desligar instruções.'
            : `Não foi possível mudar: ${errorMessage(e)}`
        )
      })
  }

  const toggleAll = (g: PluginGroup, on: boolean): void => {
    for (const i of batchToggleTargets(g, on)) toggle(i, on)
  }

  const doExport = (item: Instruction): void => {
    if (!projectId) return
    call('instructions.export', { id: item.id, projectId })
      .then((r) => toast.success(`Exportado para ${r.path}`))
      .catch((e: unknown) =>
        toast.error(
          isUnknownMethod(e)
            ? 'O agent-host ainda não suporta exportar instruções.'
            : exportErrorMessage((e as { code?: unknown } | null)?.code, errorMessage(e))
        )
      )
  }

  const checkUpdate = (item: Instruction): void => {
    setChecking(item.id)
    call('library.checkUpdate', { id: item.id })
      .then((r) => {
        if (!r.hasUpdate || !r.preview) toast.success(`“${item.name}” já está atualizado.`)
        else setUpdate({ item, preview: r.preview })
      })
      .catch((e: unknown) => toast.error(libraryErrorMessage(e)))
      .finally(() => setChecking(null))
  }

  const doDelete = (item: Instruction): void => {
    call('instructions.delete', { id: item.id })
      .then(() => remove(item.id))
      .catch((e: unknown) => toast.error(`Não foi possível excluir: ${errorMessage(e)}`))
  }

  const toolbarCtx: InstructionsToolbarContext = {
    kind,
    projectId,
    chatId,
    reload,
    edit: setEditing,
    items: list.items,
    targets
  }

  const chatTitle = (i: Instruction): string | null =>
    i.origin ? targetName('chat', i.origin.chatId) : null

  const row = (i: Instruction): React.JSX.Element => (
    <ItemRow
      key={i.id}
      item={i}
      targetName={targetName(i.scope, i.scopeId)}
      chatTitle={chatTitle(i)}
      onToggle={(on) => toggle(i, on)}
      onEdit={() => setEditing(draftFrom(i))}
      onDelete={() => setDeleting(i)}
      onExport={projectId && isEditable(i) && i.kind !== 'memory' ? () => doExport(i) : undefined}
      onCheckUpdate={i.source.type === 'github' ? () => checkUpdate(i) : undefined}
      checking={checking === i.id}
    />
  )

  return (
    <div className="flex h-full flex-col">
      <Tabs
        value={kind}
        onValueChange={(v) => setKind(v as InstructionKind)}
        className="shrink-0 gap-0"
      >
        <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
          <h2 className="text-sm font-medium">Instruções</h2>
          <TabsList className="h-8">
            {KIND_ORDER.map((k) => (
              <TabsTrigger key={k} value={k} className="gap-1.5 text-xs">
                {KIND_TAB_LABEL[k]}
                <span className="text-[10px] text-muted-foreground tabular-nums">{counts[k]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label="Fechar instruções"
            title="Voltar para a conversa"
            onClick={() => useUi.getState().setView('chat')}
          >
            <X />
          </Button>
        </div>
      </Tabs>
      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2"
        data-slot="instructions-toolbar"
      >
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            placeholder="Filtrar"
            aria-label="Filtrar instruções"
            className="h-7 w-48 pl-7 text-xs md:text-xs"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select value={scope} onValueChange={(v) => setScope(v as ScopeFilter)}>
          <SelectTrigger size="sm" className="h-7 w-40 text-xs" aria-label="Escopo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPE_FILTERS.map((s) => (
              <SelectItem key={s} value={s}>
                {s === 'all' ? 'Todos os escopos' : `Escopo: ${SCOPE_LABEL[s]}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Recarregar"
          title="Recarregar"
          onClick={reload}
        >
          <RefreshCw className={cn(list.loading && 'animate-spin')} />
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <InstructionsActions ctx={toolbarCtx} />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl p-4">
          {!projectId && (
            <p className="mb-3 text-xs text-muted-foreground">
              Sem projeto aberto: mostrando só o que é global ou criado no app.
            </p>
          )}
          {list.unsupported ? (
            <p className="text-sm text-muted-foreground">
              O agent-host ainda não suporta instruções.
            </p>
          ) : list.error ? (
            <p className="text-sm text-destructive">
              Não foi possível carregar as instruções: {list.error}
            </p>
          ) : (
            <>
              {kind === 'memory' && (
                <ThirdPartyPanel memories={memories} all={list.items} onDeleted={reload} />
              )}
              {shown.length === 0 ? (
                !list.loading && (
                  <p className="text-sm text-muted-foreground">
                    Nenhum item em {KIND_TAB_LABEL[kind].toLowerCase()}
                    {scope !== 'all' && ` com escopo ${SCOPE_LABEL[scope]}`}.
                  </p>
                )
              ) : (
                <ul className="flex flex-col gap-2">
                  {grouped.groups.map((g) => (
                    <PluginGroupSection
                      key={g.key}
                      group={g}
                      onToggleAll={(on) => toggleAll(g, on)}
                    >
                      {g.items.map(row)}
                    </PluginGroupSection>
                  ))}
                  {grouped.rest.map(row)}
                </ul>
              )}
            </>
          )}
        </div>
      </ScrollArea>
      <InstructionEditDialog
        draft={editing}
        targets={targets}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={upsert}
      />
      <GithubUpdateDialog
        target={update}
        onOpenChange={(o) => !o && setUpdate(null)}
        onUpdated={(items) => items.forEach(upsert)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Excluir item?"
        description={deleting ? `“${deleting.name}” será excluído.` : ''}
        confirmLabel="Excluir"
        onConfirm={() => deleting && doDelete(deleting)}
      />
    </div>
  )
}
