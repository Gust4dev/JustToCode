import { useEffect, useState } from 'react'
import { ChevronLeft, Download, LoaderCircle, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { GgufFile, GgufRepo, LlamaProfile, MemoryEstimate } from '@shared/components'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { ConfirmDialog } from '@renderer/features/projects/ConfirmDialog'
import { componentsApi, useComponents } from './componentsStore'
import { ErrorLine, LevelBadge, Section, Unavailable } from './common'
import {
  baseName,
  cleanError,
  formatBytes,
  formatMB,
  hfDownloadId,
  isNotImplemented,
  progressPct,
  sortGgufFiles
} from './format'
import { reportError, useAction, useLoad } from './hooks'

const CTX_OPTIONS = [4096, 8192, 16384, 32768, 65536, 131072]
const CACHE_TYPES: LlamaProfile['cacheType'][] = ['f16', 'q8_0', 'q4_0']

function HardwareSection(): React.JSX.Element {
  const api = componentsApi()
  const hw = useLoad(api ? () => api.hardware() : null, [])
  return (
    <Section title="Hardware detectado">
      {hw.unavailable ? (
        <Unavailable what="Detecção de hardware" />
      ) : hw.error ? (
        <ErrorLine msg={hw.error} />
      ) : !hw.data ? (
        <p className="text-xs text-muted-foreground">detectando…</p>
      ) : (
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <span className="text-muted-foreground">GPU</span>
          <span>{hw.data.gpuName ?? 'nenhuma GPU NVIDIA detectada'}</span>
          <span className="text-muted-foreground">VRAM</span>
          <span>{hw.data.vramMB != null ? formatMB(hw.data.vramMB) : '—'}</span>
          <span className="text-muted-foreground">RAM</span>
          <span>{formatMB(hw.data.ramMB)}</span>
          {hw.data.driver && (
            <>
              <span className="text-muted-foreground">Driver</span>
              <span>{hw.data.driver}</span>
            </>
          )}
        </div>
      )}
    </Section>
  )
}

function DownloadButton({ file }: { file: GgufFile }): React.JSX.Element {
  const api = componentsApi()
  const id = hfDownloadId(file)
  const progress = useComponents((s) => s.downloads[id])
  const [starting, setStarting] = useState(false)

  if (progress && !progress.error) {
    const pct = progressPct(progress)
    return (
      <div className="flex w-44 items-center gap-2">
        <Progress value={pct ?? 0} className="h-1.5 flex-1" />
        <span className="w-9 text-right text-xs tabular-nums">{pct != null ? `${pct}%` : '…'}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Cancelar download"
          title="Cancelar download"
          onClick={() =>
            api?.cancelDownload(id).catch((e: unknown) => reportError(e, 'Cancelar download'))
          }
        >
          <X />
        </Button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5">
      {progress?.error && (
        <span className="max-w-40 truncate text-xs text-destructive" title={progress.error}>
          {progress.error}
        </span>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={!api || starting}
        onClick={() => {
          if (!api) return
          setStarting(true)
          if (progress) useComponents.getState().dismissDownload(id)
          // Registra o id já (sem esperar o primeiro evento) para o indicador aparecer na hora.
          useComponents.getState().applyProgress({
            id,
            label: baseName(file.path),
            received: 0,
            total: file.size || null,
            done: false,
            error: null
          })
          api.models
            .download(file)
            .catch((e: unknown) => {
              const msg = cleanError(e)
              if (/cancel|abort/i.test(msg)) useComponents.getState().dismissDownload(id)
              else if (isNotImplemented(e)) {
                useComponents.getState().dismissDownload(id)
                reportError(e, 'Baixar modelo')
              } else
                useComponents.getState().applyProgress({
                  id,
                  label: baseName(file.path),
                  received: 0,
                  total: null,
                  done: true,
                  error: msg
                })
            })
            .finally(() => setStarting(false))
        }}
      >
        {starting ? <LoaderCircle className="animate-spin" /> : <Download />}
        {progress?.error ? 'Tentar de novo' : 'Baixar'}
      </Button>
    </div>
  )
}

function FileRow({
  file,
  ctx,
  cacheType
}: {
  file: GgufFile
  ctx: number
  cacheType: LlamaProfile['cacheType']
}): React.JSX.Element {
  const [est, setEst] = useState<{ key: string; v: MemoryEstimate | null; err: string | null }>({
    key: '',
    v: null,
    err: null
  })
  const key = `${file.repo}/${file.path}|${ctx}|${cacheType}`

  useEffect(() => {
    const api = componentsApi()
    if (!api) return
    let alive = true
    api.models
      .estimate(file, ctx, cacheType)
      .then((v) => alive && setEst({ key, v, err: null }))
      .catch(
        (e: unknown) =>
          alive &&
          setEst({
            key,
            v: null,
            err: isNotImplemented(e) ? 'estimativa indisponível' : cleanError(e)
          })
      )
    return () => {
      alive = false
    }
  }, [file, ctx, cacheType, key])

  const current = est.key === key ? est : null
  const shards = file.shardCount && file.shardCount > 1 ? ` · ${file.shardCount} partes` : ''

  return (
    <li className="flex flex-col gap-1 border-b py-2 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="w-20 shrink-0 font-mono text-xs font-medium">{file.quant ?? '—'}</span>
        <span className="min-w-0 flex-1 truncate text-xs" title={file.path}>
          {baseName(file.path)}
        </span>
        <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatBytes(file.size)}
          {shards}
        </span>
        <span className="w-44 shrink-0">
          {current?.v ? (
            <LevelBadge est={current.v} />
          ) : (
            <span className="text-xs text-muted-foreground">{current?.err ?? 'estimando…'}</span>
          )}
        </span>
        <DownloadButton file={file} />
      </div>
      {current?.v?.note && (
        <p className="pl-23 text-[11px] text-muted-foreground">{current.v.note}</p>
      )}
    </li>
  )
}

function SearchSection(): React.JSX.Element {
  const api = componentsApi()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<GgufRepo[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [ctx, setCtx] = useState(32768)
  const [cacheType, setCacheType] = useState<LlamaProfile['cacheType']>('q8_0')
  const { busy, run } = useAction()
  const files = useLoad(api && repo ? () => api.models.files(repo) : null, [repo])

  const search = (): void => {
    if (!api || !q.trim()) return
    void run('search', 'Buscar no Hugging Face', async () => {
      setResults(await api.models.search(q.trim()))
      setRepo(null)
    })
  }

  return (
    <Section title="Buscar modelos GGUF no Hugging Face">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          search()
        }}
      >
        <Input
          className="h-8"
          placeholder="ex.: Qwen3-Coder-30B-A3B GGUF"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button size="sm" type="submit" disabled={!api || !q.trim() || busy !== null}>
          {busy === 'search' ? <LoaderCircle className="animate-spin" /> : <Search />}
          Buscar
        </Button>
      </form>

      {repo ? (
        <div className="mt-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="xs" onClick={() => setRepo(null)}>
              <ChevronLeft />
              Resultados
            </Button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{repo}</span>
            <Select value={String(ctx)} onValueChange={(v) => setCtx(Number(v))}>
              <SelectTrigger size="sm" className="w-32" aria-label="Contexto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CTX_OPTIONS.map((c) => (
                  <SelectItem key={c} value={String(c)}>
                    ctx {c / 1024}k
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={cacheType}
              onValueChange={(v) => setCacheType(v as LlamaProfile['cacheType'])}
            >
              <SelectTrigger size="sm" className="w-28" aria-label="Tipo de cache">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CACHE_TYPES.map((c) => (
                  <SelectItem key={c} value={c}>
                    KV {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {files.loading && <p className="text-xs text-muted-foreground">listando arquivos…</p>}
          {files.unavailable && <Unavailable what="Lista de arquivos" />}
          {files.error && <ErrorLine msg={files.error} />}
          {files.data && !files.data.length && (
            <p className="text-xs text-muted-foreground">Nenhum arquivo .gguf neste repositório.</p>
          )}
          {files.data && files.data.length > 0 && (
            <ul>
              {sortGgufFiles(files.data).map((f) => (
                <FileRow key={f.path} file={f} ctx={ctx} cacheType={cacheType} />
              ))}
            </ul>
          )}
        </div>
      ) : (
        results && (
          <ul className="mt-3">
            {!results.length && (
              <li className="text-xs text-muted-foreground">Nenhum repositório encontrado.</li>
            )}
            {results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => setRepo(r.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{r.id}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {r.downloads.toLocaleString('pt-BR')} downloads · {r.likes} likes
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </Section>
  )
}

function LocalSection(): React.JSX.Element {
  const api = componentsApi()
  const dir = useLoad(api ? () => api.models.dir() : null, [])
  const local = useLoad(api ? () => api.models.local() : null, [])
  const downloadsCount = useComponents((s) => Object.keys(s.downloads).length)
  const [toRemove, setToRemove] = useState<string | null>(null)
  const { run } = useAction()
  const reloadLocal = local.reload

  // Um download terminou (saiu do mapa) → atualiza a lista local.
  useEffect(() => {
    reloadLocal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadsCount])

  return (
    <Section
      title="Modelos locais"
      actions={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Recarregar"
          title="Recarregar"
          onClick={() => local.reload()}
        >
          <RefreshCw />
        </Button>
      }
    >
      {dir.data && (
        <p className="mb-2 truncate text-xs text-muted-foreground" title={dir.data}>
          Pasta: {dir.data}
        </p>
      )}
      {local.unavailable ? (
        <Unavailable what="Lista de modelos locais" />
      ) : local.error ? (
        <ErrorLine msg={local.error} />
      ) : !local.data?.length ? (
        <p className="text-xs text-muted-foreground">
          {local.loading ? 'carregando…' : 'Nenhum modelo baixado.'}
        </p>
      ) : (
        <ul>
          {local.data.map((m) => (
            <li key={m.path} className="flex items-center gap-3 border-b py-1.5 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-sm" title={m.path}>
                {m.name}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatBytes(m.size)}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remover ${m.name}`}
                title="Remover"
                onClick={() => setToRemove(m.path)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(o) => !o && setToRemove(null)}
        title="Remover modelo?"
        description={`O arquivo ${toRemove ? baseName(toRemove) : ''} (e as demais partes, se houver) será apagado do disco.`}
        confirmLabel="Remover"
        onConfirm={() => {
          const path = toRemove
          if (!api || !path) return
          void run(
            'remove',
            'Remover modelo',
            () => api.models.remove(path),
            'Modelo removido'
          ).then(() => local.reload())
        }}
      />
    </Section>
  )
}

export function ModelsTab(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <HardwareSection />
      <SearchSection />
      <LocalSection />
    </div>
  )
}
