import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import type { AppConfig, ModelInfo } from '@shared/domain'
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
import { Switch } from '@renderer/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { ComboPanel } from '@renderer/features/context/ComboPanel'
import { UpdateSection } from '@renderer/features/update/UpdateSection'
import { call } from '@renderer/lib/host'

const NONE = '__none__'

type Models = { state: 'loading' } | { state: 'ok'; list: ModelInfo[] } | { state: 'error' }

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: (id: string) => React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children(id)}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ComboField({
  id,
  value,
  onChange,
  models,
  noneLabel = 'Nenhuma'
}: {
  id: string
  value: string
  onChange(v: string): void
  models: Models
  /** Rótulo da opção vazia (''). */
  noneLabel?: string
}): React.JSX.Element {
  if (models.state !== 'ok' || models.list.length === 0)
    return (
      <Input
        id={id}
        className="h-8 text-sm"
        placeholder={noneLabel === 'Nenhuma' ? 'Nome da combo no 9router' : noneLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  const list = [...models.list].sort(
    (a, b) => Number(b.isCombo) - Number(a.isCombo) || a.id.localeCompare(b.id)
  )
  const missing = value && !list.some((m) => m.id === value)
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger id={id} size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>
          <span className="text-muted-foreground">{noneLabel}</span>
        </SelectItem>
        {missing && <SelectItem value={value}>{value} (não listado)</SelectItem>}
        {list.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.id}
            {m.isCombo && <span className="text-[10px] text-muted-foreground">combo</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SettingsForm({ onDone }: { onDone(): void }): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [timeoutS, setTimeoutS] = useState('')
  const [thresholdS, setThresholdS] = useState('')
  const [keepS, setKeepS] = useState('')
  const [models, setModels] = useState<Models>({ state: 'loading' })
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('general')

  useEffect(() => {
    let alive = true
    window.api.settings
      .get()
      .then((c) => {
        if (!alive) return
        setCfg(c)
        setTimeoutS(String(Math.round(c.shellTimeoutMs / 1000)))
        setThresholdS(String(c.compactThresholdPct))
        setKeepS(String(c.keepRecentMessages))
      })
      .catch((e: Error) => alive && setLoadError(e.message))
    call('models.list', null)
      .then((list) => alive && setModels({ state: 'ok', list }))
      .catch(() => alive && setModels({ state: 'error' }))
    return () => {
      alive = false
    }
  }, [])

  if (loadError)
    return <p className="text-sm text-destructive">Erro ao ler configurações: {loadError}</p>
  if (!cfg) return <p className="text-sm text-muted-foreground">Carregando…</p>

  const patch = (p: Partial<AppConfig>): void => setCfg({ ...cfg, ...p })
  const seconds = Number(timeoutS)
  const timeoutValid = Number.isFinite(seconds) && seconds >= 1
  const urlValid = /^https?:\/\/\S+$/.test(cfg.routerBaseUrl.trim())
  const threshold = Number(thresholdS)
  const thresholdValid = Number.isInteger(threshold) && threshold >= 10 && threshold <= 95
  const keep = Number(keepS)
  const keepValid = Number.isInteger(keep) && keep >= 0 && keep <= 200
  const generalValid = urlValid && timeoutValid
  const contextValid = thresholdValid && keepValid
  const valid = generalValid && contextValid
  const comboHint =
    models.state === 'error'
      ? 'Não foi possível listar os modelos do 9router; digite o nome.'
      : models.state === 'loading'
        ? 'Carregando modelos…'
        : undefined

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.settings.set({
        routerBaseUrl: cfg.routerBaseUrl.trim(),
        routerApiKey: cfg.routerApiKey,
        defaultCombo: cfg.defaultCombo.trim(),
        lightCombo: cfg.lightCombo.trim(),
        shell: cfg.shell,
        shellTimeoutMs: Math.round(seconds * 1000),
        compactThresholdPct: threshold,
        keepRecentMessages: keep,
        summarizerModel: cfg.summarizerModel.trim(),
        summarizeToolOutputs: cfg.summarizeToolOutputs,
        routerDbPath: cfg.routerDbPath.trim()
      })
      toast.success('Configurações salvas')
      onDone()
    } catch (e) {
      toast.error(`Não foi possível salvar: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="min-h-0 gap-4">
      <TabsList className="h-8">
        <TabsTrigger value="general" className="text-xs">
          Geral{!generalValid && <span className="text-destructive">•</span>}
        </TabsTrigger>
        <TabsTrigger value="context" className="text-xs">
          Contexto{!contextValid && <span className="text-destructive">•</span>}
        </TabsTrigger>
        <TabsTrigger value="combos" className="text-xs">
          Combos
        </TabsTrigger>
      </TabsList>
      <form
        className={tab === 'combos' ? 'hidden' : 'grid gap-4'}
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && !saving) void save()
        }}
      >
        <TabsContent value="general" className="grid gap-4">
          <GeneralFields
            cfg={cfg}
            patch={patch}
            models={models}
            comboHint={comboHint}
            urlValid={urlValid}
            timeoutS={timeoutS}
            timeoutValid={timeoutValid}
            setTimeoutS={setTimeoutS}
          />
        </TabsContent>
        <TabsContent value="context" className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Compactar ao atingir (% da janela)"
              hint={thresholdValid ? undefined : 'Entre 10 e 95.'}
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={10}
                  max={95}
                  className="h-8 text-sm"
                  value={thresholdS}
                  aria-invalid={!thresholdValid}
                  onChange={(e) => setThresholdS(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Mensagens recentes mantidas"
              hint={keepValid ? undefined : 'Inteiro entre 0 e 200.'}
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={200}
                  className="h-8 text-sm"
                  value={keepS}
                  aria-invalid={!keepValid}
                  onChange={(e) => setKeepS(e.target.value)}
                />
              )}
            </Field>
          </div>
          <Field
            label="Modelo do resumo"
            hint={
              comboHint ??
              'Sem combo leve definida, usa a combo do próprio chat. Se o modelo falhar, tenta a combo leve e depois a do chat.'
            }
          >
            {(id) => (
              <ComboField
                id={id}
                value={cfg.summarizerModel}
                models={models}
                noneLabel="Usar combo leve"
                onChange={(v) => patch({ summarizerModel: v })}
              />
            )}
          </Field>
          <Field
            label="Resumir saídas longas de ferramentas"
            hint="Em vez de cortar a saída, pede um resumo ao modelo do resumo (a saída completa continua acessível)."
          >
            {(id) => (
              <Switch
                id={id}
                checked={cfg.summarizeToolOutputs}
                onCheckedChange={(v) => patch({ summarizeToolOutputs: v })}
              />
            )}
          </Field>
          <Field
            label="Banco do 9router (opcional)"
            hint="Usado só para ler os membros das combos, em modo somente leitura."
          >
            {(id) => (
              <Input
                id={id}
                className="h-8 font-mono text-xs"
                placeholder={'%APPDATA%\\9router\\db\\data.sqlite'}
                value={cfg.routerDbPath}
                onChange={(e) => patch({ routerDbPath: e.target.value })}
              />
            )}
          </Field>
        </TabsContent>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancelar
          </Button>
          <Button type="submit" size="sm" disabled={!valid || saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </Button>
        </DialogFooter>
      </form>
      <TabsContent value="combos" className="min-h-0 overflow-y-auto">
        <ComboPanel initialCombo={cfg.defaultCombo || undefined} />
      </TabsContent>
    </Tabs>
  )
}

function GeneralFields({
  cfg,
  patch,
  models,
  comboHint,
  urlValid,
  timeoutS,
  timeoutValid,
  setTimeoutS
}: {
  cfg: AppConfig
  patch(p: Partial<AppConfig>): void
  models: Models
  comboHint: string | undefined
  urlValid: boolean
  timeoutS: string
  timeoutValid: boolean
  setTimeoutS(v: string): void
}): React.JSX.Element {
  return (
    <>
      <Field
        label="URL do 9router"
        hint={urlValid ? undefined : 'Informe uma URL http(s), ex.: http://localhost:20128/v1'}
      >
        {(id) => (
          <Input
            id={id}
            className="h-8 text-sm"
            value={cfg.routerBaseUrl}
            aria-invalid={!urlValid}
            onChange={(e) => patch({ routerBaseUrl: e.target.value })}
          />
        )}
      </Field>
      <Field label="Chave de API" hint="Guardada criptografada neste computador.">
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="off"
            className="h-8 text-sm"
            value={cfg.routerApiKey}
            onChange={(e) => patch({ routerApiKey: e.target.value })}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Combo padrão" hint={comboHint}>
          {(id) => (
            <ComboField
              id={id}
              value={cfg.defaultCombo}
              models={models}
              onChange={(v) => patch({ defaultCombo: v })}
            />
          )}
        </Field>
        <Field label="Combo leve">
          {(id) => (
            <ComboField
              id={id}
              value={cfg.lightCombo}
              models={models}
              onChange={(v) => patch({ lightCombo: v })}
            />
          )}
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Shell">
          {(id) => (
            <Select
              value={cfg.shell}
              onValueChange={(v) => patch({ shell: v as AppConfig['shell'] })}
            >
              <SelectTrigger id={id} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automático</SelectItem>
                <SelectItem value="pwsh">PowerShell 7 (pwsh)</SelectItem>
                <SelectItem value="powershell">Windows PowerShell</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field
          label="Timeout de comando (s)"
          hint={timeoutValid ? undefined : 'Mínimo de 1 segundo.'}
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              className="h-8 text-sm"
              value={timeoutS}
              aria-invalid={!timeoutValid}
              onChange={(e) => setTimeoutS(e.target.value)}
            />
          )}
        </Field>
      </div>
      <UpdateSection />
    </>
  )
}

export function SettingsDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange(open: boolean): void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Configurações</DialogTitle>
          <DialogDescription>
            Conexão com o 9router, execução de comandos e contexto.
          </DialogDescription>
        </DialogHeader>
        {open && <SettingsForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}
