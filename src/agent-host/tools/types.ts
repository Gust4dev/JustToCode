import type { BlobStore } from '../blobs'
import type { ChangeCapture } from '../services/types'

export interface ToolContext {
  projectId: string
  projectRoot: string
  chatId: string
  toolCallId: string
  signal: AbortSignal
  blobs: BlobStore
  capture: ChangeCapture
  config: { shell: 'auto' | 'pwsh' | 'powershell'; shellTimeoutMs: number }
  onOutput(delta: string): void
}

export interface ToolResult {
  content: string
  isError?: boolean
  images?: { mime: string; blobHash: string }[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<A = any> {
  name: string
  description: string
  /** JSON Schema de objeto (formato OpenAI function.parameters). */
  parameters: Record<string, unknown>
  kind: 'read' | 'edit' | 'command'
  /** Texto curto para cards e aprovações. Ex.: "edit src/a.ts", "npm test". */
  summarize(args: A): string
  run(args: A, ctx: ToolContext): Promise<ToolResult>
}
