import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Paperclip, Sparkles, Square, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import type { SlashCommand } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { errorMessage } from '@renderer/features/projects/store'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { ComboSelect } from '@renderer/features/context/ComboSelect'
import { ContextMeter } from '@renderer/features/context/ContextMeter'
import { PermissionModeSelect } from '@renderer/features/context/PermissionModeSelect'
import { AttachmentChips } from './AttachmentChips'
import {
  MAX_IMAGE_BYTES,
  formatBytes,
  isImageFile,
  readImageFile,
  type DraftAttachment
} from './attachments'
import { filterCommands, moveIndex, resolveSlashText, slashQuery } from './slashCommands'

/** Comandos por projeto; host sem `ecosystem.commands` → lista vazia. */
const commandCache = new Map<string, Promise<SlashCommand[]>>()

function loadCommands(projectId: string, fresh = false): Promise<SlashCommand[]> {
  let p = fresh ? undefined : commandCache.get(projectId)
  if (!p) {
    p = call('ecosystem.commands', { projectId }).catch((e) => {
      commandCache.delete(projectId)
      if ((e as { code?: unknown } | null)?.code !== 'UNKNOWN_METHOD')
        console.warn('ecosystem.commands falhou', e)
      return [] as SlashCommand[]
    })
    commandCache.set(projectId, p)
  }
  return p
}

function SlashMenu({
  items,
  active,
  onPick,
  onHover
}: {
  items: SlashCommand[]
  active: number
  onPick(c: SlashCommand): void
  onHover(i: number): void
}): React.JSX.Element {
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Comandos"
      className="absolute right-0 bottom-full left-0 z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.map((c, i) => (
        <li
          key={`${c.source}:${c.scope}:${c.name}`}
          role="option"
          aria-selected={i === active}
          data-index={i}
          className={cn(
            'flex cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-xs',
            i === active && 'bg-accent text-accent-foreground'
          )}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(c)
          }}
          onMouseMove={() => onHover(i)}
        >
          {c.source === 'skill' ? (
            <Sparkles className="mt-px size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <SquareTerminal className="mt-px size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0 font-mono font-medium">/{c.name}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={c.description}>
            {c.description}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            {c.scope === 'project' ? 'projeto' : 'global'}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function Composer({
  chatId,
  projectId,
  busy,
  onSend,
  onStop
}: {
  chatId: string
  /** Projeto do chat (para os slash commands); null = sem autocomplete. */
  projectId: string | null
  busy: boolean
  /** Devolve true se a mensagem foi aceita (o rascunho é limpo). */
  onSend(text: string, attachments: DraftAttachment[]): Promise<boolean>
  onStop(): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [items, setItems] = useState<DraftAttachment[]>([])
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [commands, setCommands] = useState<{ projectId: string; list: SlashCommand[] } | null>(null)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)

  const query = slashQuery(text)
  const wantsCommands = query !== null && projectId !== null
  useEffect(() => {
    if (!wantsCommands || !projectId || commands?.projectId === projectId) return
    let alive = true
    void loadCommands(projectId).then((list) => alive && setCommands({ projectId, list }))
    return () => {
      alive = false
    }
  }, [wantsCommands, projectId, commands?.projectId])

  // Cada `/` novo recarrega a lista (comandos criados com o app aberto aparecem).
  const justSlash = text === '/'
  useEffect(() => {
    if (!justSlash || !projectId) return
    let alive = true
    void loadCommands(projectId, true).then((list) => alive && setCommands({ projectId, list }))
    return () => {
      alive = false
    }
  }, [justSlash, projectId])

  const cmdList = useMemo(
    () => (commands && commands.projectId === projectId ? commands.list : []),
    [commands, projectId]
  )
  const matches = useMemo(
    () => (query === null ? [] : filterCommands(cmdList, query)),
    [cmdList, query]
  )
  const menuOpen = matches.length > 0 && dismissed !== text
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1))

  const pick = (c: SlashCommand): void => {
    setText(`/${c.name} `)
    setActive(0)
    areaRef.current?.focus()
  }

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  useLayoutEffect(() => {
    areaRef.current?.focus()
  }, [chatId])

  const addFiles = async (files: File[]): Promise<void> => {
    const images = files.filter(isImageFile)
    if (images.length < files.length) toast.warning('Por enquanto só dá para anexar imagens.')
    const ok = images.filter((f) => {
      if (f.size <= MAX_IMAGE_BYTES) return true
      toast.error(`${f.name || 'Imagem'} passa de ${formatBytes(MAX_IMAGE_BYTES)}.`)
      return false
    })
    if (ok.length === 0) return
    try {
      const read = await Promise.all(ok.map(readImageFile))
      setItems((cur) => [...cur, ...read])
    } catch (e) {
      toast.error(`Não foi possível ler a imagem: ${(e as Error).message}`)
    }
  }

  const canSend = !busy && !sending && (text.trim().length > 0 || items.length > 0)

  const submit = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    try {
      let outgoing = text.trim()
      if (projectId && outgoing.startsWith('/')) {
        const list = await loadCommands(projectId)
        try {
          outgoing = await resolveSlashText(outgoing, list, (name, args) =>
            call('ecosystem.expandCommand', { projectId, name, args })
          )
        } catch (e) {
          toast.error(`Não foi possível expandir o comando: ${errorMessage(e)}`)
          return
        }
      }
      if (await onSend(outgoing, items)) {
        setText('')
        setItems([])
      }
    } finally {
      setSending(false)
      areaRef.current?.focus()
    }
  }

  return (
    <div className="shrink-0 px-3 pb-3">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            'relative rounded-xl border bg-card shadow-xs transition-colors focus-within:border-ring/60',
            dragging && 'border-primary bg-primary/5'
          )}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length === 0) return
            e.preventDefault()
            setDragging(false)
            void addFiles([...e.dataTransfer.files])
          }}
        >
          {menuOpen && (
            <SlashMenu items={matches} active={activeIndex} onPick={pick} onHover={setActive} />
          )}
          <AttachmentChips
            items={items}
            onRemove={(id) => setItems((cur) => cur.filter((a) => a.id !== id))}
          />
          <textarea
            ref={areaRef}
            rows={1}
            value={text}
            placeholder={
              busy ? 'O agente está trabalhando…' : 'Peça algo ao agente (/ para comandos)'
            }
            aria-label="Mensagem"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            className="block max-h-60 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-muted-foreground"
            onChange={(e) => {
              setText(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (menuOpen) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive(moveIndex(activeIndex, e.key === 'ArrowDown' ? 1 : -1, matches.length))
                  return
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
                  e.preventDefault()
                  pick(matches[activeIndex])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setDismissed(text)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (files.length === 0) return
              e.preventDefault()
              void addFiles(files)
            }}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-1.5 pb-1.5 [&>*]:max-w-full [&>*]:min-w-0">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Anexar imagem"
              title="Anexar imagem"
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip />
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                e.target.value = ''
                void addFiles(files)
              }}
            />
            <ComboSelect chatId={chatId} />
            <PermissionModeSelect chatId={chatId} />
            <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
              <span className="flex shrink-0 items-center whitespace-nowrap [&_*]:whitespace-nowrap">
                <ContextMeter chatId={chatId} />
              </span>
              {busy ? (
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="size-7 rounded-lg"
                  aria-label="Parar"
                  title="Parar"
                  onClick={onStop}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  className="size-7 rounded-lg"
                  aria-label="Enviar"
                  title="Enviar (Enter)"
                  disabled={!canSend}
                  onClick={() => void submit()}
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
