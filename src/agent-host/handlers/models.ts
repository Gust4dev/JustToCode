import type { ModelInfo } from '@shared/domain'
import type { HandlerModule } from '../context'
import { getConfig } from '../config'
import { createOpenAiClient } from '../model/openaiClient'
import type { ModelClient } from '../model/types'

let shared: ModelClient | null = null

/** ModelClient único do host, lendo sempre a config atual. */
export function getModelClient(): ModelClient {
  return (shared ??= createOpenAiClient(getConfig))
}

export const modelsHandlers: HandlerModule = () => ({
  'models.list': (): Promise<ModelInfo[]> => getModelClient().listModels()
})
