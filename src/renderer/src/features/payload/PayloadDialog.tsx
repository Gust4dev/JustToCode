import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { InstructionFile, RequestRecord, SkillInfo } from '@shared/domain'
import { call } from '@renderer/lib/host'
import { useUi } from '@renderer/stores/ui'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'

interface PayloadDialogProps {
  requestId: string
  open: boolean
  onOpenChange(open: boolean): void
}

interface Loaded {
  json: string
  parsed: unknown
  record: RequestRecord | null
}

interface MessageView {
  role: string
  text: string
  images: string[]
  toolCalls: string[]
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Extrai role, texto, imagens (data URLs) e nomes de ferramentas das mensagens do request OpenAI. */
function toMessageViews(payload: unknown): MessageView[] {
  if (!isObj(payload) || !Array.isArray(payload.messages)) return []
  return payload.messages.map((m): MessageView => {
    const msg = isObj(m) ? m : {}
    const role = typeof msg.role === 'string' ? msg.role : '?'
    const texts: string[] = []
    const images: string[] = []
    const content = msg.content
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (!isObj(part)) continue
        if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
        else if (part.type === 'image_url') {
          const iu = part.image_url
          const url = isObj(iu) ? iu.url : iu
          if (typeof url === 'string') images.push(url)
        }
      }
    }
    const toolCalls: string[] = []
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (isObj(tc) && isObj(tc.function) && typeof tc.function.name === 'string') {
          toolCalls.push(tc.function.name)
        }
      }
    }
    return { role, text: texts.join('\n'), images, toolCalls }
  })
}

function fmtNum(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('pt-BR')
}

function fmtDuration(r: RequestRecord): string {
  if (r.finishedAt == null) return 'em andamento'
  const ms = r.finishedAt - r.startedAt
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function preview(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-mono break-all">{value}</span>
    </div>
  )
}

function Summary({
  record,
  payload
}: {
  record: RequestRecord | null
  payload: unknown
}): React.JSX.Element {
  const model = isObj(payload) && typeof payload.model === 'string' ? payload.model : null
  if (!record) {
    return (
      <div className="text-sm">
        <Row label="Modelo pedido" value={model ?? '—'} />
        <p className="mt-2 text-muted-foreground">Registro do request não encontrado neste chat.</p>
      </div>
    )
  }
  return (
    <div>
      <Row label="Modelo pedido" value={record.modelRequested} />
      <Row label="Modelo reportado" value={record.modelReported ?? '—'} />
      <Row label="Tokens estimados" value={fmtNum(record.estTokens)} />
      <Row label="Tokens de prompt reportados" value={fmtNum(record.promptTokens)} />
      <Row label="Tokens de resposta reportados" value={fmtNum(record.completionTokens)} />
      <Row label="Janela efetiva" value={fmtNum(record.effectiveWindow)} />
      <Row label="Duração" value={fmtDuration(record)} />
      <Row
        label="Erro"
        value={record.error ? <span className="text-destructive">{record.error}</span> : '—'}
      />
    </div>
  )
}

function Messages({ payload }: { payload: unknown }): React.JSX.Element {
  const views = useMemo(() => toMessageViews(payload), [payload])
  if (views.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhuma mensagem no payload.</p>
  }
  return (
    <ul className="flex flex-col gap-2">
      {views.map((v, i) => (
        <li key={i} className="rounded-md border p-2 text-sm">
          <div className="mb-1 text-xs font-medium text-muted-foreground uppercase">{v.role}</div>
          {v.text && (
            <pre className="font-sans text-xs whitespace-pre-wrap break-words">
              {preview(v.text)}
            </pre>
          )}
          {v.toolCalls.length > 0 && (
            <div className="mt-1 font-mono text-xs text-muted-foreground">
              Chamadas: {v.toolCalls.join(', ')}
            </div>
          )}
          {v.images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {v.images.map((src, j) => (
                <img
                  key={j}
                  src={src}
                  alt={`Imagem ${j + 1}`}
                  className="h-20 w-20 rounded border object-cover"
                />
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function JsonView({ json, parsed }: { json: string; parsed: unknown }): React.JSX.Element {
  const pretty = useMemo(
    () => (parsed === undefined ? json : JSON.stringify(parsed, null, 2)),
    [json, parsed]
  )
  const copy = (): void => {
    navigator.clipboard.writeText(pretty).then(
      () => toast.success('JSON copiado'),
      () => toast.error('Não foi possível copiar')
    )
  }
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={copy}>
          Copiar
        </Button>
      </div>
      <pre className="max-h-[55vh] overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs select-text">
        {pretty}
      </pre>
    </div>
  )
}

type Listing<T> =
  { kind: 'ok'; items: T[] } | { kind: 'unavailable' } | { kind: 'error'; text: string }

function toListing<T>(r: PromiseSettledResult<T[]>): Listing<T> {
  if (r.status === 'fulfilled') return { kind: 'ok', items: r.value }
  const e = r.reason as { code?: unknown; message?: unknown } | null
  if (e?.code === 'UNKNOWN_METHOD') return { kind: 'unavailable' }
  return { kind: 'error', text: typeof e?.message === 'string' ? e.message : String(r.reason) }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1).replace('.', ',')} KB`
}

const SCOPE_LABEL = { global: 'global', project: 'projeto' } as const

function ListingState<T>({
  listing,
  empty,
  children
}: {
  listing: Listing<T> | null
  empty: string
  children(items: T[]): React.ReactNode
}): React.JSX.Element {
  if (!listing) return <p className="text-sm text-muted-foreground">Carregando…</p>
  if (listing.kind === 'unavailable')
    return <p className="text-sm text-muted-foreground">Indisponível nesta versão do agent-host.</p>
  if (listing.kind === 'error')
    return <p className="text-sm text-destructive">Erro ao carregar: {listing.text}</p>
  if (listing.items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return <>{children(listing.items)}</>
}

function Instructions({ projectId }: { projectId: string | null }): React.JSX.Element {
  const [files, setFiles] = useState<Listing<InstructionFile> | null>(null)
  const [skills, setSkills] = useState<Listing<SkillInfo> | null>(null)

  useEffect(() => {
    if (!projectId) return
    let alive = true
    void Promise.allSettled([
      call('ecosystem.instructions', { projectId }),
      call('ecosystem.skills', { projectId })
    ]).then(([f, s]) => {
      if (!alive) return
      setFiles(toListing(f))
      setSkills(toListing(s))
    })
    return () => {
      alive = false
    }
  }, [projectId])

  if (!projectId) return <p className="text-sm text-muted-foreground">Nenhum projeto aberto.</p>
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase">
          Arquivos de instrução
        </h3>
        <p className="text-xs text-muted-foreground">
          O conteúdo entra no system prompt (bloco “User instructions”); veja em Mensagens.
        </p>
        <ListingState listing={files} empty="Nenhum arquivo de instrução encontrado.">
          {(items) => (
            <ul className="flex flex-col">
              {items.map((f) => (
                <li
                  key={f.path}
                  className="flex items-center gap-3 border-b py-1.5 text-sm last:border-0"
                >
                  <span className="min-w-0 flex-1 font-mono text-xs break-all">{f.path}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {SCOPE_LABEL[f.scope]}
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">
                    {fmtBytes(f.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ListingState>
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase">Skills disponíveis</h3>
        <ListingState listing={skills} empty="Nenhuma skill encontrada.">
          {(items) => (
            <ul className="flex flex-col">
              {items.map((s) => (
                <li
                  key={`${s.scope}:${s.name}`}
                  className="flex flex-col gap-0.5 border-b py-1.5 text-sm last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium">{s.name}</span>
                    <span className="text-xs text-muted-foreground">{SCOPE_LABEL[s.scope]}</span>
                  </div>
                  {s.description && (
                    <span className="text-xs text-muted-foreground">{s.description}</span>
                  )}
                  <span className="font-mono text-[11px] break-all text-muted-foreground/70">
                    {s.path}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ListingState>
      </section>
    </div>
  )
}

export function PayloadDialog({
  requestId,
  open,
  onOpenChange
}: PayloadDialogProps): React.JSX.Element {
  const chatId = useUi((s) => s.chatId)
  const projectId = useUi((s) => s.projectId)
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const [{ json }, records] = await Promise.all([
          call('requests.payload', { id: requestId }),
          chatId ? call('requests.list', { chatId }) : Promise.resolve([] as RequestRecord[])
        ])
        let parsed: unknown = undefined
        try {
          parsed = JSON.parse(json)
        } catch {
          // payload não é JSON válido: mostra o texto cru na aba JSON
        }
        const record = records.find((r) => r.id === requestId) ?? null
        if (!cancelled) setData({ json, parsed, record })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open, requestId, chatId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Payload do request</DialogTitle>
          <DialogDescription className="font-mono text-xs">{requestId}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">Erro ao carregar o payload: {error}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : (
          <Tabs defaultValue="resumo" className="min-h-0 flex-1">
            <TabsList>
              <TabsTrigger value="resumo">Resumo</TabsTrigger>
              <TabsTrigger value="mensagens">Mensagens</TabsTrigger>
              <TabsTrigger value="instrucoes">Instruções</TabsTrigger>
              <TabsTrigger value="json">JSON</TabsTrigger>
            </TabsList>
            <TabsContent value="resumo" className="overflow-auto">
              <Summary record={data.record} payload={data.parsed} />
            </TabsContent>
            <TabsContent value="mensagens" className="max-h-[60vh] overflow-auto">
              <Messages payload={data.parsed} />
            </TabsContent>
            <TabsContent value="instrucoes" className="max-h-[60vh] overflow-auto">
              <Instructions projectId={projectId} />
            </TabsContent>
            <TabsContent value="json">
              <JsonView json={data.json} parsed={data.parsed} />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}
