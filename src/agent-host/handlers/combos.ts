import type { HostParams, HostResult } from '@shared/api'
import type { HandlerModule } from '../context'
import type { ComboResolver } from '../context/comboResolver'
import type { ComboOverrideRepo } from '../repo/comboOverrides'
import type { ModelWindowRepo } from '../repo/modelWindows'

export function comboHandlers(d: {
  resolver: ComboResolver
  overrides: ComboOverrideRepo
  windows: ModelWindowRepo
}): HandlerModule {
  return () => ({
    'combos.info': (p: HostParams<'combos.info'>): Promise<HostResult<'combos.info'>> =>
      d.resolver.info(p.combo),
    'combos.setOverride': (
      p: HostParams<'combos.setOverride'>
    ): Promise<HostResult<'combos.setOverride'>> => {
      d.overrides.set(p.combo, {
        members: p.members,
        ignored: p.ignored,
        windowOverride: p.windowOverride
      })
      d.resolver.invalidate()
      return d.resolver.info(p.combo)
    },
    'models.setWindow': (p: HostParams<'models.setWindow'>): HostResult<'models.setWindow'> => {
      d.windows.set(p.modelId, p.contextWindow)
      d.resolver.invalidate()
      return null
    }
  })
}
