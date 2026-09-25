import { Check, Copy } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { useCopy } from './useCopy'

/** Botão só com ícone (Copy → Check), para blocos de código. */
export function CopyIconButton({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const { copied, copy } = useCopy()
  return (
    <button
      type="button"
      aria-label={copied ? 'Copiado' : 'Copiar'}
      title={copied ? 'Copiado' : 'Copiar'}
      onClick={() => copy(text)}
      className={cn(
        'rounded border bg-background/80 p-1 text-muted-foreground hover:text-foreground',
        className
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

/** Ação discreta "Copiar" (texto), no rodapé da mensagem. */
export function CopyTextButton({ text }: { text: string }): React.JSX.Element {
  const { copied, copy } = useCopy()
  return (
    <button
      type="button"
      aria-label="Copiar resposta"
      onClick={() => copy(text)}
      className="text-xs text-muted-foreground/60 underline-offset-2 hover:text-muted-foreground hover:underline"
    >
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  )
}
