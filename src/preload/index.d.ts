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
        /** Versão atual (app.getVersion()) e se é o app instalado (app.isPackaged). */
        info(): Promise<{ version: string; isPackaged: boolean }>
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
