import type { UpdateState } from '../main/updater/state'
import type { AppConfig } from '../shared/domain'
import type { ComponentsApi } from '../shared/components'

declare global {
  interface Window {
    api: {
      components: ComponentsApi
      update: {
        onState(cb: (s: UpdateState) => void): () => void
        download(): Promise<void>
        install(): Promise<void>
        check(): Promise<void>
      }
      settings: {
        get(): Promise<AppConfig>
        set(p: Partial<AppConfig>): Promise<AppConfig>
      }
      dialog: {
        pickFolder(): Promise<string | null>
      }
    }
  }
}

export {}
