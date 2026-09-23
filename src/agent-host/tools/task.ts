import type { Tool, ToolContext, ToolResult } from './types'

export const TASK_TOOL = 'task'

export interface TaskArgs {
  agent: string
  description: string
  prompt: string
}

export interface SubagentRequest extends TaskArgs {
  parentChatId: string
  /** Tool call `task` do pai. */
  toolCallId: string
  signal: AbortSignal
}

export type SubagentRunner = (req: SubagentRequest) => Promise<ToolResult>

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Ferramenta `task`: dispara um subagente (chat filho) e devolve o último texto dele.
 * `run` é injetado depois (o engine só existe depois das ferramentas).
 */
export function createTaskTool(run: () => SubagentRunner): Tool<TaskArgs> {
  return {
    name: TASK_TOOL,
    kind: 'command',
    description:
      'Launch a subagent to handle a self-contained task with its own context. ' +
      'The subagent has the same tools as you (except task) unless its definition restricts them, ' +
      'and returns its final message as the result. Use agent "general" unless a more specific ' +
      'agent from the Subagents list fits. Several task calls in the same response run in parallel. ' +
      'The prompt must be self-contained: the subagent does not see this conversation.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Subagent name (e.g. "general").' },
        description: { type: 'string', description: 'Short (3-5 words) description of the task.' },
        prompt: { type: 'string', description: 'Full instructions for the subagent.' }
      },
      required: ['agent', 'description', 'prompt'],
      additionalProperties: false
    },
    summarize: (a) => `subagent ${str(a?.agent) || 'general'}: ${str(a?.description)}`,
    async run(args, ctx: ToolContext) {
      const prompt = str(args?.prompt)
      if (!prompt) return { content: 'Missing required parameter: prompt', isError: true }
      return run()({
        agent: str(args?.agent) || 'general',
        description: str(args?.description) || prompt.slice(0, 60),
        prompt,
        parentChatId: ctx.chatId,
        toolCallId: ctx.toolCallId,
        signal: ctx.signal
      })
    }
  }
}
