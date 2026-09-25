import { useEffect, useId, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { DEFAULT_CHAT_SETTINGS, type Chat, type ChatSettings } from '@shared/domain'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { errorMessage, isUnknownMethod, useProjects } from '@renderer/features/projects/store'
import { retainModelsRefresh, useModels } from '@renderer/features/context/modelsStore'
import { formatTokenInput, parseTokenInput } from '@renderer/features/chat/runControls'
import {
  REASONING_LEVELS,
  fromOption,
  parseIterationsInput,
  toOption,
  DEFAULT_OPTION,
  type ChatPatch
} from './logic'

function save(chatId: string, patch: ChatPatch): void {
  useProjects
    .getState()
    .updateChat(chatId, patch)
    .catch((e: unknown) =>
      toast.error(
        isUnknownMethod(e)
          ? 'O agent-host ainda não suporta esse ajuste.'
          : `Não foi possível salvar o ajuste: ${errorMessage(e)}`
      )
    )
}

function OptionSelect({
  label,
  value,
  options,
  defaultLabel,
  onChange
}: {
  label: string
  value: string | null
  options: string[]
  defaultLabel: string
  onChange(v: string | null): void
}): React.JSX.Element {
  const id = useId()
  const known = value === null || options.includes(value)
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <Select value={toOption(value)} onValueChange={(v) => onChange(fromOption(v))}>
        <SelectTrigger id={id} size="sm" className="h-7 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={DEFAULT_OPTION}>{defaultLabel}</SelectItem>
          {!known && value && <SelectItem value={value}>{value}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function NumberField({
  label,
  value,
  placeholder,
  title,
  format,
  parse,
  invalid,
  onCommit
}: {
  label: string
  value: number | null
  placeholder: string
  title: string
  format(n: number | null): string
  parse(t: string): number | null | undefined
  invalid: string
  onCommit(n: number | null): void
}): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const n = parse(draft)
    setDraft(null)
    if (n === undefined) {
      toast.error(invalid)
      return
    }
    if (n !== value) onCommit(n)
  }
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        value={draft ?? format(value)}
        placeholder={placeholder}
        title={title}
        inputMode="numeric"
        className="h-7 text-xs md:text-xs"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') setDraft(null)
        }}
      />
    </div>
  )
}

/** Painel "Ajustes do chat" (header): reasoning, subagentes, resumo e limites. */
export function ChatSettingsPanel({ chat }: { chat: Chat }): React.JSX.Element {
  const models = useModels((s) => s.models)
  useEffect(() => retainModelsRefresh(), [])
  const ids = models.map((m) => m.id)
  const combos = models.filter((m) => m.isCombo).map((m) => m.id)
  // Host antigo pode mandar o chat sem settings.
  const settings = chat.settings ?? DEFAULT_CHAT_SETTINGS
  const setSetting = <K extends keyof ChatSettings>(k: K, v: ChatSettings[K]): void => {
    if (settings[k] === v) return
    save(chat.id, { settings: { [k]: v } as Partial<ChatSettings> })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Ajustes do chat" title="Ajustes do chat">
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="mb-3 text-sm font-medium">Ajustes do chat</p>
        <div className="grid gap-3">
          <OptionSelect
            label="Reasoning"
            value={settings.reasoning}
            options={REASONING_LEVELS}
            defaultLabel="Padrão do modelo"
            onChange={(v) => setSetting('reasoning', v as ChatSettings['reasoning'])}
          />
          <div className="grid grid-cols-2 gap-2">
            <OptionSelect
              label="Combo dos subagentes"
              value={settings.subagentCombo}
              options={combos.length ? combos : ids}
              defaultLabel="Mesma do chat"
              onChange={(v) => setSetting('subagentCombo', v)}
            />
            <OptionSelect
              label="Reasoning dos subagentes"
              value={settings.subagentReasoning}
              options={REASONING_LEVELS}
              defaultLabel="Padrão"
              onChange={(v) =>
                setSetting('subagentReasoning', v as ChatSettings['subagentReasoning'])
              }
            />
          </div>
          <OptionSelect
            label="Modelo do resumo (compactação)"
            value={settings.summarizerModel}
            options={ids}
            defaultLabel="Padrão das configurações"
            onChange={(v) => setSetting('summarizerModel', v)}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              key={`b-${chat.id}-${chat.tokenBudget}`}
              label="Orçamento (tokens)"
              value={chat.tokenBudget}
              placeholder="sem"
              title="Tokens por turno (ex.: 200k). Vazio = sem orçamento."
              format={formatTokenInput}
              parse={parseTokenInput}
              invalid="Orçamento inválido: use um número de tokens (ex.: 200k)."
              onCommit={(n) => save(chat.id, { tokenBudget: n })}
            />
            <NumberField
              key={`i-${chat.id}-${chat.maxIterations}`}
              label="Limite de iterações"
              value={chat.maxIterations}
              placeholder="sem limite"
              title="Iterações por turno. Vazio = sem limite (contínuo)."
              format={(n) => (n === null ? '' : String(n))}
              parse={parseIterationsInput}
              invalid="Limite inválido: use um número inteiro maior que zero."
              onCommit={(n) => save(chat.id, { maxIterations: n })}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
