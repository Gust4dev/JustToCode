import { useEffect, useId, useState } from 'react'
import { Info, LoaderCircle, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import type { ComboInfo } from '@shared/domain'
import type { HostParams } from '@shared/api'
import { call } from '@renderer/lib/host'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Textarea } from '@renderer/components/ui/textarea'
import { cn } from '@renderer/lib/utils'
import { errorMessage } from '@renderer/features/projects/store'
import { formatTokens } from './format'
import { retainModelsRefresh, useModels } from './modelsStore'

const SOURCE_LABEL: Record<ComboInfo['source'], string> = {
  'router-db': 'banco do 9router',
  manual: 'manual',
  model: 'modelo',
  unknown: 'desconhecida'
}

type Loaded =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; info: ComboInfo }

const describeError = (e: unknown): string =>
  (e as { code?: unknown } | null)?.code === 'UNKNOWN_METHOD'
    ? 'o agent-host ainda não oferece informações de combos.'
    : errorMessage(e)

/** Inteiro positivo, vazio (= null) ou inválido (undefined). */
function parseWindow(raw: string): number | null | undefined {
  const t = raw.trim().replace(/[._\s]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** Input de janela que só grava ao sair do campo ou com Enter. */
function WindowInput({
  value,
  placeholder,
  ariaLabel,
  onCommit
}: {
  value: number | null
  placeholder?: string
  ariaLabel: string
  onCommit(v: number | null): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === null ? '' : String(value))
  const parsed = parseWindow(shown)
  const commit = (): void => {
    if (draft === null) return
    setDraft(null)
    if (parsed === undefined || parsed === value) return
    onCommit(parsed)
  }
  return (
    <Input
      inputMode="numeric"
      aria-label={ariaLabel}
      aria-invalid={parsed === undefined}
      placeholder={placeholder}
      className="h-7 w-28 text-right text-xs tabular-nums"
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}

function ComboDetails({
  info,
  busy,
  onOverride,
  onSetWindow
}: {
  info: ComboInfo
  busy: boolean
  onOverride(p: Omit<HostParams<'combos.setOverride'>, 'combo'>): void
  onSetWindow(modelId: string, contextWindow: number | null): void
}): React.JSX.Element {
  const membersId = useId()
  const [membersDraft, setMembersDraft] = useState('')
  const ignored = new Set(info.ignored)
  const windowOverride = info.limitingModel === 'manual' ? info.effectiveWindow : null

  const toggleIgnored = (m: string, ignore: boolean): void => {
    const next = ignore ? [...info.ignored, m] : info.ignored.filter((x) => x !== m)
    onOverride({ ignored: [...new Set(next)] })
  }

  const saveMembers = (): void => {
    const members = [
      ...new Set(
        membersDraft
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      )
    ]
    if (members.length === 0) return
    onOverride({ members })
    setMembersDraft('')
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          Janela efetiva:{' '}
          <span className="font-medium text-foreground tabular-nums">
            {info.effectiveWindow === null ? '?' : formatTokens(info.effectiveWindow)}
          </span>
          {info.limitingModel && (
            <>
              {' '}
              · limitada por <span className="font-mono">{info.limitingModel}</span>
            </>
          )}
        </span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          membros: {SOURCE_LABEL[info.source]}
        </Badge>
        {busy && <LoaderCircle className="size-3 animate-spin" />}
      </div>

      {info.warning && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">{info.warning}</p>
        </div>
      )}

      {info.members.length > 0 && (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Membro</th>
                <th className="px-2 py-1.5 text-right font-medium">Janela (tokens)</th>
                {info.isCombo && <th className="px-2 py-1.5 text-center font-medium">Ignorar</th>}
              </tr>
            </thead>
            <tbody>
              {info.members.map((m) => {
                const w = info.windows[m] ?? null
                const limiting = m === info.limitingModel
                return (
                  <tr key={m} className={cn('border-t', ignored.has(m) && 'opacity-50')}>
                    <td className="max-w-0 px-2 py-1">
                      <span
                        className={cn('block truncate font-mono', limiting && 'font-semibold')}
                        title={limiting ? `${m} (limitante)` : m}
                      >
                        {m}
                      </span>
                    </td>
                    <td className="px-2 py-1">
                      <div className="flex justify-end">
                        <WindowInput
                          value={w}
                          placeholder="desconhecida"
                          ariaLabel={`Janela de ${m}`}
                          onCommit={(v) => onSetWindow(m, v)}
                        />
                      </div>
                    </td>
                    {info.isCombo && (
                      <td className="px-2 py-1 text-center">
                        <Checkbox
                          aria-label={`Ignorar ${m}`}
                          checked={ignored.has(m)}
                          disabled={busy}
                          onCheckedChange={(v) => toggleIgnored(m, v === true)}
                        />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {info.members.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Edite a janela de um modelo para corrigir o valor do 9router; deixe vazio para voltar ao
          padrão.
        </p>
      )}

      {info.isCombo && (
        <div className="flex items-center justify-between gap-3">
          <Label className="text-xs font-normal">Janela da combo (substitui o mínimo)</Label>
          <div className="flex items-center gap-1.5">
            <WindowInput
              value={windowOverride}
              placeholder="automática"
              ariaLabel="Janela da combo"
              onCommit={(v) => onOverride({ windowOverride: v })}
            />
            {windowOverride !== null && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => onOverride({ windowOverride: null })}
              >
                Limpar
              </Button>
            )}
          </div>
        </div>
      )}

      {info.isCombo && (info.source === 'unknown' || info.source === 'manual') && (
        <div className="grid gap-1.5">
          <Label htmlFor={membersId} className="text-xs">
            Membros (um por linha)
          </Label>
          <Textarea
            id={membersId}
            className="min-h-20 font-mono text-xs"
            placeholder={info.source === 'manual' ? info.members.join('\n') : 'provedor/modelo'}
            value={membersDraft}
            onChange={(e) => setMembersDraft(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            {info.source === 'manual' && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => onOverride({ members: null })}
              >
                Voltar a ler do 9router
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={busy || !membersDraft.trim()}
              onClick={saveMembers}
            >
              Salvar membros
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ComboPanel({ initialCombo }: { initialCombo?: string }): React.JSX.Element {
  const models = useModels((s) => s.models)
  const modelsError = useModels((s) => s.error)
  const [picked, setPicked] = useState<string>('')
  const [loaded, setLoaded] = useState<{ combo: string; data: Loaded } | null>(null)
  const [busy, setBusy] = useState(false)
  const selectId = useId()

  useEffect(() => retainModelsRefresh(), [])

  const combos = models.filter((m) => m.isCombo)
  const plain = models.filter((m) => !m.isCombo)
  const combo = picked || initialCombo || combos[0]?.id || ''

  useEffect(() => {
    if (!combo) return
    let alive = true
    call('combos.info', { combo })
      .then((info) => alive && setLoaded({ combo, data: { state: 'ok', info } }))
      .catch(
        (e: unknown) =>
          alive && setLoaded({ combo, data: { state: 'error', message: describeError(e) } })
      )
    return () => {
      alive = false
    }
  }, [combo])

  const data: Loaded = loaded?.combo === combo ? loaded.data : { state: 'loading' }

  const run = (p: Promise<ComboInfo | null>): void => {
    setBusy(true)
    p.then((info) => {
      if (info) setLoaded({ combo: info.combo, data: { state: 'ok', info } })
    })
      .catch((e: unknown) => toast.error(`Não foi possível salvar: ${describeError(e)}`))
      .finally(() => setBusy(false))
  }

  const onOverride = (p: Omit<HostParams<'combos.setOverride'>, 'combo'>): void =>
    run(call('combos.setOverride', { combo, ...p }))

  const onSetWindow = (modelId: string, contextWindow: number | null): void =>
    run(
      call('models.setWindow', { modelId, contextWindow }).then(() =>
        call('combos.info', { combo })
      )
    )

  const known = models.some((m) => m.id === combo)

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={selectId} className="text-xs">
          Combo
        </Label>
        <Select value={combo || undefined} onValueChange={setPicked}>
          <SelectTrigger id={selectId} size="sm" className="w-full">
            <SelectValue placeholder={modelsError ? 'Modelos indisponíveis' : 'Escolha a combo'} />
          </SelectTrigger>
          <SelectContent>
            {combo && !known && <SelectItem value={combo}>{combo}</SelectItem>}
            {combos.length > 0 && (
              <SelectGroup>
                <SelectLabel>Combos</SelectLabel>
                {combos.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {plain.length > 0 && (
              <SelectGroup>
                <SelectLabel>Modelos</SelectLabel>
                {plain.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </div>

      {!combo ? (
        <p className="text-xs text-muted-foreground">
          {modelsError
            ? `Não foi possível listar os modelos do 9router: ${modelsError}`
            : 'Nenhuma combo disponível.'}
        </p>
      ) : data.state === 'loading' ? (
        <p className="text-xs text-muted-foreground">Carregando…</p>
      ) : data.state === 'error' ? (
        <p className="text-xs text-muted-foreground">Painel indisponível: {data.message}</p>
      ) : (
        <ComboDetails
          key={combo}
          info={data.info}
          busy={busy}
          onOverride={onOverride}
          onSetWindow={onSetWindow}
        />
      )}

      <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0" />
        <p>
          Uma combo com um membro de janela pequena limita todos os outros. Ignore o membro ou crie
          uma combo só com modelos de janela grande.
        </p>
      </div>
    </div>
  )
}
