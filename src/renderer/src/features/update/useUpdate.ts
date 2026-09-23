import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../../main/updater/state'

export function useUpdate(): UpdateState {
  const [s, setS] = useState<UpdateState>({ phase: 'idle' })
  useEffect(() => window.api.update.onState(setS), [])
  return s
}
