import { createContext, useContext } from 'react'
import type { SubagentMap } from './subagents'

/** Subagentes do chat aberto (toolCallId da `task` → chat filho), fornecido pelo ChatView. */
export const SubagentContext = createContext<SubagentMap>({})

export const useSubagents = (): SubagentMap => useContext(SubagentContext)
