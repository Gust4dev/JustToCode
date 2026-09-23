import type {
  Approval,
  ChangeOrigin,
  ChatStatus,
  CompactionRecord,
  CompactionTrigger,
  ContextState,
  StoredMessage,
  ToolCallRecord
} from './domain'

export const ENGINE_EVENT = 'engine'

export type EngineEvent =
  | { type: 'chat_status_changed'; chatId: string; status: ChatStatus }
  | { type: 'message_added'; chatId: string; message: StoredMessage }
  | { type: 'turn_started'; chatId: string; requestId: string; model: string }
  | { type: 'text_delta'; chatId: string; requestId: string; delta: string }
  | { type: 'reasoning_delta'; chatId: string; requestId: string; delta: string }
  | { type: 'tool_call_started'; chatId: string; toolCall: ToolCallRecord }
  | { type: 'tool_output_delta'; chatId: string; toolCallId: string; delta: string }
  | { type: 'tool_call_finished'; chatId: string; toolCall: ToolCallRecord }
  | { type: 'permission_requested'; approval: Approval }
  | { type: 'permission_resolved'; approval: Approval }
  | {
      type: 'file_touched'
      projectId: string
      chatId: string | null
      path: string
      origin: ChangeOrigin
    }
  | { type: 'context_updated'; chatId: string; context: ContextState }
  | { type: 'provider_switched'; chatId: string; from: string | null; to: string }
  | { type: 'turn_finished'; chatId: string; requestId: string }
  | { type: 'turn_error'; chatId: string; message: string; code?: string }
  | { type: 'compaction_started'; chatId: string; trigger: CompactionTrigger }
  | {
      type: 'compaction_finished'
      chatId: string
      compaction: CompactionRecord
      summaryMessage: StoredMessage
    }
  | { type: 'compaction_failed'; chatId: string; message: string }
  | {
      type: 'subagent_started'
      chatId: string
      childChatId: string
      agentName: string
      toolCallId: string
    }
  | { type: 'subagent_finished'; chatId: string; childChatId: string; toolCallId: string }
