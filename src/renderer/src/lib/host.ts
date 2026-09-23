import type { HostMethod, HostParams, HostResult } from '@shared/api'
import { getAgent } from './agent'

export async function call<M extends HostMethod>(
  method: M,
  params: HostParams<M>
): Promise<HostResult<M>> {
  const agent = await getAgent()
  return agent.call<HostResult<M>>(method, params)
}
