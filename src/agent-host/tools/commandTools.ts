import type { Tool } from './types'
import { shellTool } from './shell'

export { shellTool }
export const commandTools: Tool[] = [shellTool]
