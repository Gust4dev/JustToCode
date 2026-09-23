import { useEffect, useId, useState } from 'react'
import {
  Copy,
  Download,
  ExternalLink,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import type { LlamaBackend, LlamaProfile, LocalModel, MemoryEstimate } from '@shared/components'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import { ConfirmDialog } from '@renderer/features/projects/ConfirmDialog'
import { componentsApi, refreshStatus, useComponents } from './componentsStore'
import { ErrorLine, LevelBadge, LogView, Section, Unavailable } from './common'
import {
  BACKEND_LABEL,
  cleanError,
  formatBytes,
  latestByBackend,
  llamaEndpoint,
  localToGgufFile,
  modelIdFromPath,
  newProfile,
  ownershipLabel,
  previewArgs,
  recommendedBackend,
  releaseSize,
  ROUTER_DASHBOARD,
  statusText,
  validPort
} from './format'
import { openExternal, useAction, useLoad } from './hooks'

const BACKENDS: LlamaBackend[] = ['cuda-12.4', 'cuda-13.4', 'vulkan', 'cpu']
const CACHE_TYPES: LlamaProfile['cacheType'][] = ['f16', 'q8_0', 'q4_0']

function InstallSection(): React.JSX.Element {
  const api = componentsApi()
  const status = useComponents((s) => s.statuses.llama)
  const hw = useLoad(api ? () => api.hardware() : null, [])
  const releases = useLoad(api ? () => api.llama.releases() : null, [])
  const [picked, setPicked] = useState<LlamaBackend | null>(null)
  const backend = picked ?? recommendedBackend(hw.data)
  const recommended = recommendedBackend(hw.data)
  const latest = latestByBackend(releases.data ?? [])
  const release = latest[backend]
  const { busy, run } = useAction()

  return (
    <Section
      title="llama.cpp (llama-server)"
      actions={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Recarregar releases"
          title="Recarregar releases"
          onClick={() => {
            releases.reload()
            void refreshStatus()
          }}
        >
          <RefreshCw />
        </Button>
      }
    >
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <span className="text-muted-foreground">Status</span>
        <span className="flex items-center gap-2">
          {statusText(status)}
          {status?.running && <Badge variant="outline">{ownershipLabel(status.ownership)}</Badge>}
        </span>
        <span className="text-muted-foreground">Versão atual</span>
        <span>{status?.installed ? (status.version ?? 'desconhecida') : '—'}</span>
        <span className="text-muted-foreground">GPU</span>
        <span>
          {hw.data
            ? hw.data.gpuName
              ? `${hw.data.gpuName}${hw.data.vramMB ? ` · ${formatBytes(hw.data.vramMB * 2 ** 20)}` : ''}`
              : 'nenhuma GPU NVIDIA detectada'
            : hw.unavailable
              ? 'detecção indisponível'
              : '…'}
        </span>
      </div>
      {status?.message && <p className="mt-2 text-xs text-muted-foreground">{status.message}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={backend} onValueChange={(v) => setPicked(v as LlamaBackend)}>
          <SelectTrigger size="sm" className="w-56" aria-label="Backend">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BACKENDS.map((b) => (
              <SelectItem key={b} value={b}>
                {BACKEND_LABEL[b]}
                {b === recommended ? ' (recomendado)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={!api || busy !== null || (!release && !releases.unavailable)}
          onClick={() =>
            api &&
            void run(
              'install',
              'Instalar o llama.cpp',
              () => api.llama.install(backend),
              'llama.cpp instalado'
            ).then(() => refreshStatus())
          }
        >
          {busy === 'install' ? <LoaderCircle className="animate-spin" /> : <Download />}
          {status?.installed ? 'Atualizar / trocar backend' : 'Instalar'}
        </Button>
        {release && (
          <span className="text-xs text-muted-foreground">
            {release.tag} · download {formatBytes(releaseSize(release))}
          </span>
        )}
      </div>
      <div className="mt-2">
        {releases.loading && <p className="text-xs text-muted-foreground">buscando releases…</p>}
        {releases.unavailable && <Unavailable what="Lista de releases" />}
        {releases.error && <ErrorLine msg={`Releases indisponíveis: ${releases.error}`} />}
        {releases.data && !release && (
          <p className="text-xs text-muted-foreground">
            Nenhuma release recente com {BACKEND_LABEL[backend]} para Windows.
          </p>
        )}
      </div>
    </Section>
  )
}

/** Estimativa ao vivo (com debounce) para o modelo/contexto/cache do perfil. */
function useProfileEstimate(
  draft: LlamaProfile | null,
  models: LocalModel[]
): { est: MemoryEstimate | null; note: string | null } {
  const [state, setState] = useState<{ est: MemoryEstimate | null; note: string | null }>({
    est: null,
    note: null
  })
  const modelPath = draft?.modelPath ?? ''
  const ctx = draft?.ctx ?? 0
  const cacheType = draft?.cacheType ?? 'q8_0'
  const local = models.find((m) => m.path === modelPath) ?? null

  useEffect(() => {
    const api = componentsApi()
    const file = local ? localToGgufFile(local) : null
    if (!api || !file || !(ctx > 0)) {
      const t = setTimeout(
        () =>
          setState({
            est: null,
            note: local && !file ? 'estimativa só para modelos baixados pelo app' : null
          }),
        0
      )
      return () => clearTimeout(t)
    }
    let alive = true
    const t = setTimeout(() => {
      api.models
        .estimate(file, ctx, cacheType)
        .then((est) => alive && setState({ est, note: null }))
        .catch((e: unknown) => alive && setState({ est: null, note: cleanError(e) }))
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [local, ctx, cacheType])

  return state
}

function Field({
  label,
  children,
  hint
}: {
  label: string
  children: (id: string) => React.ReactNode
  hint?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children(id)}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  )
}

function numberOr(v: string, fallback: number): number {
  const n = Number(v)
  return v.trim() !== '' && Number.isFinite(n) ? Math.round(n) : fallback
}

function ProfilesSection(): React.JSX.Element {
  const api = componentsApi()
  const status = useComponents((s) => s.statuses.llama)
  const profiles = useLoad(api ? () => api.llama.profiles() : null, [])
  const models = useLoad(api ? () => api.models.local() : null, [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<LlamaProfile | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { busy, run } = useAction()

  const list = profiles.data ?? []
  const current = selectedId ? (list.find((p) => p.id === selectedId) ?? null) : (list[0] ?? null)
  // Rascunho vale enquanto for do perfil selecionado; trocar de perfil recomeça do salvo.
  const editing =
    draft && (draft.id === current?.id || !list.some((p) => p.id === draft.id)) ? draft : current
  const localModels = models.data ?? []
  const { est, note } = useProfileEstimate(editing, localModels)
  const dirty = !!editing && JSON.stringify(editing) !== JSON.stringify(current)
  const portOk = editing ? validPort(editing.port) : true

  const patch = (p: Partial<LlamaProfile>): void => {
    if (editing) setDraft({ ...editing, ...p })
  }

  const save = (): Promise<boolean> =>
    !api || !editing
      ? Promise.resolve(false)
      : run('save', 'Salvar perfil', async () => {
          const saved = await api.llama.saveProfile(editing)
          setDraft(null)
          setSelectedId(saved.id)
          profiles.reload()
        })

  const running = !!status?.running

  if (profiles.unavailable) {
    return (
      <Section title="Perfis">
        <Unavailable what="Perfis do llama-server" />
      </Section>
    )
  }

  return (
    <>
      <Section
        title="Perfis"
        actions={
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              const p = newProfile(crypto.randomUUID())
              setDraft(p)
              setSelectedId(p.id)
            }}
          >
            <Plus />
            Novo perfil
          </Button>
        }
      >
        {profiles.error && <ErrorLine msg={profiles.error} />}
        {!editing ? (
          <p className="text-xs text-muted-foreground">
            {profiles.loading
              ? 'carregando…'
              : 'Nenhum perfil. Crie um para iniciar o llama-server.'}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {list.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {list.map((p) => (
                  <Button
                    key={p.id}
                    size="xs"
                    variant={p.id === editing.id ? 'secondary' : 'ghost'}
                    onClick={() => {
                      setSelectedId(p.id)
                      setDraft(null)
                    }}
                  >
                    {p.name}
                  </Button>
                ))}
                {!list.some((p) => p.id === editing.id) && (
                  <Button size="xs" variant="secondary">
                    {editing.name} (não salvo)
                  </Button>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Field label="Nome">
                {(id) => (
                  <Input
                    id={id}
                    className="h-8"
                    value={editing.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                )}
              </Field>
              <div className="col-span-1 lg:col-span-3">
                <Field
                  label="Modelo"
                  hint={
                    models.unavailable
                      ? 'lista de modelos locais ainda não disponível'
                      : localModels.length
                        ? undefined
                        : 'nenhum modelo baixado — use a aba Modelos'
                  }
                >
                  {(id) => (
                    <Select
                      value={editing.modelPath || undefined}
                      onValueChange={(v) => patch({ modelPath: v })}
                    >
                      <SelectTrigger id={id} size="sm" className="w-full">
                        <SelectValue placeholder="Escolha um modelo local" />
                      </SelectTrigger>
                      <SelectContent>
                        {editing.modelPath &&
                          !localModels.some((m) => m.path === editing.modelPath) && (
                            <SelectItem value={editing.modelPath}>
                              {editing.modelPath} (não encontrado)
                            </SelectItem>
                          )}
                        {localModels.map((m) => (
                          <SelectItem key={m.path} value={m.path}>
                            {m.name} · {formatBytes(m.size)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              </div>
              <Field label="Contexto (-c)">
                {(id) => (
                  <Input
                    id={id}
                    className="h-8"
                    type="number"
                    min={512}
                    step={1024}
                    value={editing.ctx}
                    onChange={(e) => patch({ ctx: numberOr(e.target.value, editing.ctx) })}
                  />
                )}
              </Field>
              <Field label="--n-cpu-moe" hint="vazio = desligado">
                {(id) => (
                  <Input
                    id={id}
                    className="h-8"
                    type="number"
                    min={0}
                    value={editing.nCpuMoe ?? ''}
                    onChange={(e) =>
                      patch({
                        nCpuMoe: e.target.value.trim() === '' ? null : numberOr(e.target.value, 0)
                      })
                    }
                  />
                )}
              </Field>
              <Field label="-ngl" hint="99 = tudo que couber">
                {(id) => (
                  <Input
                    id={id}
                    className="h-8"
                    type="number"
                    min={0}
                    value={editing.ngl}
                    onChange={(e) => patch({ ngl: numberOr(e.target.value, editing.ngl) })}
                  />
                )}
              </Field>
              <Field label="Porta">
                {(id) => (
                  <Input
                    id={id}
                    className="h-8"
                    type="number"
                    min={1024}
                    max={65535}
                    aria-invalid={!portOk}
                    value={editing.port}
                    onChange={(e) => patch({ port: numberOr(e.target.value, editing.port) })}
                  />
                )}
              </Field>
              <Field label="Cache KV">
                {(id) => (
                  <Select
                    value={editing.cacheType}
                    onValueChange={(v) => patch({ cacheType: v as LlamaProfile['cacheType'] })}
                  >
                    <SelectTrigger id={id} size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CACHE_TYPES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label="Flash attention">
                {(id) => (
                  <div className="flex h-8 items-center">
                    <Switch
                      id={id}
                      checked={editing.flashAttn}
                      onCheckedChange={(v) => patch({ flashAttn: v })}
                    />
                  </div>
                )}
              </Field>
              <div className="col-span-2">
                <Field
                  label="Args extras"
                  hint="separados por espaço; use aspas para valores com espaço"
                >
                  {(id) => (
                    <Input
                      id={id}
                      className="h-8 font-mono text-xs"
                      value={editing.extraArgs}
                      onChange={(e) => patch({ extraArgs: e.target.value })}
                    />
                  )}
                </Field>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Memória estimada:</span>
              {est ? (
                <>
                  <LevelBadge est={est} />
                  <span className="text-muted-foreground">{est.note}</span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {note ?? (editing.modelPath ? 'calculando…' : 'escolha um modelo')}
                </span>
              )}
            </div>

            <code className="block overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-nowrap">
              llama-server {previewArgs(editing).join(' ')}
            </code>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!dirty || !portOk || busy !== null}
                onClick={() => void save()}
              >
                {busy === 'save' ? <LoaderCircle className="animate-spin" /> : <Save />}
                Salvar
              </Button>
              {running ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!api || busy !== null}
                  onClick={() =>
                    api &&
                    void run('stop', 'Parar o llama-server', async () => {
                      useComponents.getState().setStatus(await api.stop('llama'))
                    })
                  }
                >
                  {busy === 'stop' ? <LoaderCircle className="animate-spin" /> : <Square />}
                  Parar
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={
                    !api || busy !== null || !status?.installed || !portOk || !editing.modelPath
                  }
                  title={!status?.installed ? 'Instale o llama.cpp primeiro' : undefined}
                  onClick={async () => {
                    if (!api) return
                    if (dirty && !(await save())) return
                    await run('start', 'Iniciar o llama-server', async () => {
                      useComponents.getState().setStatus(await api.start('llama', editing.id))
                    })
                  }}
                >
                  {busy === 'start' ? <LoaderCircle className="animate-spin" /> : <Play />}
                  {dirty ? 'Salvar e iniciar' : 'Iniciar'}
                </Button>
              )}
              {list.some((p) => p.id === editing.id) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-destructive"
                  disabled={busy !== null}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 />
                  Excluir
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => {
                    setDraft(null)
                    setSelectedId(null)
                  }}
                >
                  Descartar
                </Button>
              )}
            </div>
          </div>
        )}
      </Section>

      {editing && <RegisterCard profile={editing} />}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Excluir perfil?"
        description={`O perfil "${editing?.name ?? ''}" será removido. O modelo não é apagado.`}
        confirmLabel="Excluir"
        onConfirm={() =>
          api &&
          editing &&
          void run('delete', 'Excluir perfil', async () => {
            await api.llama.deleteProfile(editing.id)
            setDraft(null)
            setSelectedId(null)
            profiles.reload()
          })
        }
      />
    </>
  )
}

/** Passo guiado: o 9router não tem API de cadastro, então mostramos o que colar no dashboard. */
function RegisterCard({ profile }: { profile: LlamaProfile }): React.JSX.Element {
  const url = llamaEndpoint(profile.port)
  const model = profile.modelPath ? modelIdFromPath(profile.modelPath) : '<modelo>'
  const copy = (text: string): void => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success('Copiado'))
      .catch(() => toast.error('Não foi possível copiar'))
  }
  const row = (label: string, value: string): React.JSX.Element => (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs">
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Copiar ${label}`}
        title="Copiar"
        onClick={() => copy(value)}
      >
        <Copy />
      </Button>
    </div>
  )
  return (
    <Section title="Cadastrar no 9router">
      <div className="flex flex-col gap-2 text-sm">
        {row('URL', url)}
        {row('Modelo', model)}
        <ol className={cn('mt-1 list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground')}>
          <li>No dashboard do 9router, abra Providers.</li>
          <li>Adicione um endpoint OpenAI-compatible com a URL acima (sem chave de API).</li>
          <li>Cadastre o modelo com o nome acima e use-o numa combo.</li>
        </ol>
        <div>
          <Button size="sm" variant="outline" onClick={() => openExternal(ROUTER_DASHBOARD)}>
            <ExternalLink />
            Abrir dashboard do 9router
          </Button>
        </div>
      </div>
    </Section>
  )
}

export function LlamaTab(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <InstallSection />
      <ProfilesSection />
      <LogView id="llama" />
    </div>
  )
}
