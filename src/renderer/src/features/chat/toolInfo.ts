import {
  Bot,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  FolderTree,
  ScrollText,
  Search,
  Terminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'

const ICONS: Record<string, LucideIcon> = {
  read_file: FileText,
  write_file: FilePlus,
  edit_file: FilePen,
  glob: FolderSearch,
  grep: Search,
  list_dir: FolderTree,
  shell: Terminal,
  read_tool_output: ScrollText,
  task: Bot,
  skill: ScrollText
}

export const toolIcon = (name: string): LucideIcon => ICONS[name] ?? Wrench

/** Os argumentos podem chegar como objeto ou como a string JSON crua do modelo. */
export function parseArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args))
    return args as Record<string, unknown>
  if (typeof args === 'string') {
    try {
      const v: unknown = JSON.parse(args)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // JSON inválido: o card mostra o nome da ferramenta
    }
  }
  return {}
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Espelha o `summarize` das ferramentas do host (Tasks 1.4/1.5). */
export function summarizeTool(name: string, args: unknown): string {
  const a = parseArgs(args)
  const path = str(a.path)
  switch (name) {
    case 'read_file':
      return `read ${path}`
    case 'write_file':
      return `write ${path}`
    case 'edit_file':
      return `edit ${path}`
    case 'glob':
      return `glob ${str(a.pattern)}`
    case 'grep':
      return `grep "${str(a.pattern)}"${path ? ` ${path}` : ''}`
    case 'list_dir':
      return `ls ${path || '.'}`
    case 'shell': {
      const cmd = str(a.command)
      return cmd.length > 120 ? `${cmd.slice(0, 119)}…` : cmd
    }
    case 'read_tool_output':
      return `ler saída ${str(a.id).slice(0, 8)}`
    case 'task':
      return `subagent ${str(a.agent) || 'general'}: ${str(a.description)}`
    case 'skill':
      return `skill ${str(a.name)}`
    default:
      return name
  }
}
