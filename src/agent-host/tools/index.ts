import type { Tool } from './types'
import { readFileTool } from './readFile'
import { writeFileTool } from './writeFile'
import { editFileTool } from './editFile'
import { globTool } from './glob'
import { grepTool } from './grep'
import { listDirTool } from './listDir'

export const fileTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  listDirTool
]
