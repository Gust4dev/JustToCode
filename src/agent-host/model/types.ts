import type { ChatMessage, ModelInfo, ToolCallSpec } from '@shared/domain'

export interface ChatRequestTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools: ChatRequestTool[]
}

export type ModelEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_calls'; calls: ToolCallSpec[] }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'model_reported'; model: string }
  | { type: 'done'; finishReason: string | null }

export interface ModelClient {
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
  listModels(): Promise<ModelInfo[]>
}
