import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, CheckCheck, GitCommitHorizontal, Undo2, X } from 'lucide-react'
import type { ChangedFileSummary, Chat } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { useEngineEvent } from '@renderer/lib/engineEvents'
import { errorMessage } from '@renderer/features/projects/store'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { FileList } from './FileList'
import { CommitMessageDialog } from './CommitMessageDialog'
import type { ConflictTarget } from './ConflictDialog'
import { interpretRevert, originLabels } from './origins'

// Monaco é pesado: só carrega quando um arquivo é aberto (ou um conflito aparece).
const DiffView = lazy(() => import('./DiffView').then((m) => ({ default: m.DiffView })))
const ConflictDialog = lazy(() =>
  import('./ConflictDialog').then((m) => ({ default: m.ConflictDialog }))
)

type Filter = 'all' | 'chat'
const DEBOUNCE_MS = 300

export function DiffPanel({
  projectId,
  chatId
}: {
  projectId: string
  chatId: string | null
}): React.JSX.Element {
  const [filterPref, setFilter] = useState<Filter>('all')
  const filter: Filter = chatId ? filterPref : 'all'
  const filterChatId = filter === 'chat' ? chatId : null

  const [files, setFiles] = useState<ChangedFileSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [chats, setChats] = useState<Map<string, Chat>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<ConflictTarget | null>(null)
  const [commitOpen, setCommitOpen] = useState(false)
  const reqSeq = useRef(0)

  const loadChats = useCallback(
    (): Promise<void> =>
      call('chats.list', { projectId }).then(
        (list) => setChats(new Map(list.map((c) => [c.id, c]))),
        () => undefined // sem cores: as bolinhas ficam neutras
      ),
    [projectId]
  )

  const refresh = useCallback((): Promise<void> => {
    const seq = ++reqSeq.current
    return call('changes.list', {
      projectId,
      ...(filterChatId ? { chatId: filterChatId } : {})
    }).then(
      (list) => {
        if (seq !== reqSeq.current) return
        setFiles(list)
        setLoadError(null)
        setVersion((v) => v + 1)
      },
      (e) => {
        if (seq === reqSeq.current) setLoadError(errorMessage(e))
      }
    )
  }, [projectId, filterChatId])

  useEffect(() => {
    void loadChats()
  }, [loadChats])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Chat novo mexeu em arquivo → recarrega as cores (uma vez por id desconhecido; chat apagado não entra em loop).
  const askedIds = useRef(new Set<string>())
  useEffect(() => {
    const unknown = (files ?? []).flatMap((f) =>
      f.chatIds.filter((id) => !chats.has(id) && !askedIds.current.has(id))
    )
    if (unknown.length === 0) return
    unknown.forEach((id) => askedIds.current.add(id))
    void loadChats()
  }, [files, chats, loadChats])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  useEngineEvent((e) => {
    if (e.type !== 'file_touched' || e.projectId !== projectId) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void refresh()
    }, DEBOUNCE_MS)
  })

  const selectedFile = useMemo(
    () => files?.find((f) => f.path === selected) ?? null,
    [files, selected]
  )

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const acceptAll = (): Promise<void> =>
    run(async () => {
      try {
        await call('changes.accept', {
          projectId,
          ...(filterChatId ? { chatId: filterChatId } : {})
        })
        setSelected(null)
      } catch (e) {
        toast.error(`Não foi possível aceitar: ${errorMessage(e)}`)
      }
    })

  const acceptFile = (path: string): Promise<void> =>
    run(async () => {
      try {
        await call('changes.accept', {
          projectId,
          path,
          ...(filterChatId ? { chatId: filterChatId } : {})
        })
        setSelected(null)
      } catch (e) {
        toast.error(`Não foi possível aceitar: ${errorMessage(e)}`)
      }
    })

  const revertFile = (path: string, fromChatId: string): Promise<void> =>
    run(async () => {
      try {
        const r = interpretRevert(
          await call('changes.revert', { projectId, chatId: fromChatId, path })
        )
        if (r.kind === 'reverted')
          toast.success('Alterações do chat revertidas', { description: path })
        else if (r.kind === 'conflict')
          setConflict({ path, chatId: fromChatId, conflict: r.conflict, message: r.message })
        else setConflict({ path, chatId: fromChatId, conflict: null, message: r.message })
      } catch (e) {
        toast.error(`Não foi possível reverter: ${errorMessage(e)}`)
      }
    })

  const revertChatId =
    selectedFile && chatId && selectedFile.chatIds.includes(chatId) ? chatId : null
  const count = files?.length ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <div className="flex rounded-md border p-0.5 text-xs">
          <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
            Todos
          </FilterButton>
          <FilterButton
            active={filter === 'chat'}
            disabled={!chatId}
            onClick={() => setFilter('chat')}
          >
            Este chat
          </FilterButton>
        </div>
        <span className="ml-1 text-xs text-muted-foreground">
          {count === 1 ? '1 arquivo' : `${count} arquivos`}
        </span>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={busy || count === 0}
          onClick={() => void acceptAll()}
        >
          <CheckCheck />
          Aceitar tudo
        </Button>
      </div>

      <div
        className={cn(
          'min-h-0 overflow-y-auto',
          selectedFile ? 'max-h-[35%] shrink-0 border-b' : 'flex-1'
        )}
      >
        {loadError ? (
          <Empty text={`Não foi possível listar as alterações: ${loadError}`} />
        ) : files === null ? (
          <Empty text="Carregando…" />
        ) : files.length === 0 ? (
          <Empty text="Nenhuma alteração para revisar." />
        ) : (
          <FileList files={files} chats={chats} selected={selected} onSelect={setSelected} />
        )}
      </div>

      {selectedFile && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b px-2 py-1">
            <span className="min-w-0 flex-1 truncate text-xs" title={selectedFile.path}>
              {selectedFile.path}
              {originLabels(selectedFile).length > 0 && (
                <span className="ml-1.5 text-muted-foreground italic">
                  {originLabels(selectedFile).join(' ')}
                </span>
              )}
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void acceptFile(selectedFile.path)}
            >
              <Check />
              Aceitar
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy || !revertChatId}
              title={
                revertChatId
                  ? 'Desfaz as alterações deste chat no arquivo'
                  : 'Selecione um chat que mexeu neste arquivo para reverter'
              }
              onClick={() => revertChatId && void revertFile(selectedFile.path, revertChatId)}
            >
              <Undo2 />
              Reverter
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Fechar diff"
              onClick={() => setSelected(null)}
            >
              <X />
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <Suspense fallback={<Empty text="Carregando editor…" />}>
              <DiffView
                projectId={projectId}
                path={selectedFile.path}
                chatId={filterChatId}
                version={version}
              />
            </Suspense>
          </div>
        </div>
      )}

      <div className="flex shrink-0 items-center border-t px-2 py-1.5">
        <Button
          size="xs"
          variant="ghost"
          title="Gera uma mensagem de commit a partir das mudanças do repositório (não commita)"
          onClick={() => setCommitOpen(true)}
        >
          <GitCommitHorizontal />
          Gerar mensagem de commit
        </Button>
      </div>
      {commitOpen && (
        <CommitMessageDialog
          key={projectId}
          projectId={projectId}
          onClose={() => setCommitOpen(false)}
        />
      )}
      {conflict && (
        <Suspense fallback={null}>
          <ConflictDialog
            key={`${conflict.chatId}|${conflict.path}`}
            projectId={projectId}
            target={conflict}
            onClose={() => setConflict(null)}
            onResolved={() => {
              setConflict(null)
              void refresh()
            }}
          />
        </Suspense>
      )}
    </div>
  )
}

function FilterButton({
  active,
  disabled,
  onClick,
  children
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 disabled:opacity-50',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}
