import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Copy, LoaderCircle, RefreshCw } from 'lucide-react'
import { call } from '@renderer/lib/host'
import { errorMessage } from '@renderer/features/projects/store'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Textarea } from '@renderer/components/ui/textarea'
import { commitErrorText } from './origins'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; staged: boolean; model: string }
  | { kind: 'error'; text: string }

/** Gera (nunca commita) uma mensagem de commit via `git.commitMessage`; texto editável e copiável. */
export function CommitMessageDialog({
  projectId,
  onClose
}: {
  projectId: string
  onClose(): void
}): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [message, setMessage] = useState('')
  const seq = useRef(0)

  // Só os callbacks da promessa mexem no estado: o efeito de abertura não faz setState síncrono.
  const request = useCallback((): void => {
    const id = ++seq.current
    call('git.commitMessage', { projectId }).then(
      (r) => {
        if (id !== seq.current) return
        setMessage(r.message)
        setState({ kind: 'ready', staged: r.staged, model: r.model })
      },
      (e) => {
        if (id !== seq.current) return
        const code = (e as { code?: unknown } | null)?.code
        setState({
          kind: 'error',
          text: commitErrorText(typeof code === 'string' ? code : undefined, errorMessage(e))
        })
      }
    )
  }, [projectId])

  const generate = (): void => {
    setState({ kind: 'loading' })
    request()
  }

  // Montado só enquanto aberto (o DiffPanel desmonta ao fechar): gera ao abrir.
  useEffect(() => {
    request()
    const current = seq
    return () => {
      current.current++
    }
  }, [request])

  const copy = (): void => {
    navigator.clipboard.writeText(message).then(
      () => toast.success('Mensagem copiada'),
      () => toast.error('Não foi possível copiar')
    )
  }

  const loading = state.kind === 'loading'
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Mensagem de commit</DialogTitle>
          <DialogDescription>
            Gerada a partir das mudanças do repositório. O JustToCode não faz o commit: copie e use
            no seu git.
          </DialogDescription>
        </DialogHeader>

        {state.kind === 'ready' && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{state.staged ? 'staged' : 'working tree'}</Badge>
            <span>
              {state.staged
                ? 'baseada só no que está no stage'
                : 'nada no stage: baseada na working tree e nos arquivos novos'}
            </span>
            {state.model && <span className="ml-auto font-mono">{state.model}</span>}
          </div>
        )}

        {state.kind === 'error' ? (
          <p role="alert" className="text-sm text-destructive">
            {state.text}
          </p>
        ) : loading && !message ? (
          <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Gerando mensagem…
          </div>
        ) : (
          <Textarea
            aria-label="Mensagem de commit"
            value={message}
            disabled={loading}
            onChange={(e) => setMessage(e.target.value)}
            className="min-h-48 font-mono text-xs"
          />
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" disabled={loading} onClick={generate}>
            {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            Gerar de novo
          </Button>
          <Button
            size="sm"
            disabled={loading || state.kind !== 'ready' || !message.trim()}
            onClick={copy}
          >
            <Copy />
            Copiar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
