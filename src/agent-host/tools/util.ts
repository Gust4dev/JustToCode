import type { CaptureMeta } from '../services/types'
import type { ToolContext, ToolResult } from './types'

export function toolError(e: unknown): ToolResult {
  return { content: e instanceof Error ? e.message : String(e), isError: true }
}

export function captureMeta(ctx: ToolContext): CaptureMeta {
  return {
    projectId: ctx.projectId,
    projectRoot: ctx.projectRoot,
    chatId: ctx.chatId,
    toolCallId: ctx.toolCallId
  }
}

export function countLines(s: string): number {
  if (s === '') return 0
  const n = s.split('\n').length
  return s.endsWith('\n') ? n - 1 : n
}
