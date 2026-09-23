import { toast } from 'sonner'
import type { RpcError } from '@shared/rpc'
import { onAgentClient } from '@renderer/lib/agent'
import { subscribeEngine } from '@renderer/lib/engineEvents'
import { call } from '@renderer/lib/host'
import { errorMessage } from '@renderer/features/projects/store'
import { useApprovals } from './approvalsStore'

async function reload(): Promise<void> {
  try {
    const approvals = await call('approvals.list', {})
    useApprovals.getState().dispatch({ type: 'loaded', approvals })
  } catch (e) {
    toast.error(`Não foi possível carregar as aprovações: ${errorMessage(e)}`)
  }
}

let refs = 0
let stop: (() => void) | null = null

/**
 * Liga o store aos eventos do engine e recarrega a lista a cada cliente novo (carga e restart
 * do host). Idempotente por contagem de referências; devolve a função de desligar.
 */
export function startApprovalsFeed(): () => void {
  refs++
  if (!stop) {
    const offEvents = subscribeEngine((e) => {
      const { dispatch } = useApprovals.getState()
      if (e.type === 'permission_requested') dispatch({ type: 'requested', approval: e.approval })
      else if (e.type === 'permission_resolved')
        dispatch({ type: 'resolved', approval: e.approval })
    })
    const offClient = onAgentClient(() => void reload())
    stop = () => {
      offEvents()
      offClient()
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    refs--
    if (refs === 0 && stop) {
      stop()
      stop = null
    }
  }
}

/** Envia a decisão; o estado final chega pelo evento `permission_resolved`. */
export async function decideApproval(
  id: string,
  decision: 'allow' | 'deny',
  remember: boolean
): Promise<void> {
  const store = useApprovals.getState()
  if (store.deciding[id]) return
  store.setDeciding(id, true)
  try {
    await call('approvals.decide', { id, decision, remember })
  } catch (e) {
    const code = (e as RpcError | undefined)?.code
    if (code === 'ALREADY_DECIDED') {
      toast.info('Essa aprovação já foi decidida')
      await reload()
    } else if (code === 'NOT_FOUND') {
      toast.info('Essa aprovação não existe mais')
      useApprovals.getState().dispatch({ type: 'removed', id })
    } else {
      toast.error(`Não foi possível registrar a decisão: ${errorMessage(e)}`)
    }
  } finally {
    useApprovals.getState().setDeciding(id, false)
  }
}
