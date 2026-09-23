import { existsSync, readdirSync, statSync } from 'node:fs'
import type { Tool, ToolResult } from './types'
import { resolveInside } from './pathGuard'
import { toolError } from './util'

const MAX = 1000

interface Args {
  path?: string
}

export const listDirTool: Tool<Args> = {
  name: 'list_dir',
  description:
    'List the entries of a directory (sorted; directories end with "/"). Ignores .git. Up to 1000 entries.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory relative to the project root (default: root).'
      }
    },
    additionalProperties: false
  },
  kind: 'read',
  summarize: (a) => `ls ${a.path || '.'}`,
  async run(a, ctx): Promise<ToolResult> {
    try {
      const { abs, rel } = resolveInside(ctx.projectRoot, a.path ?? '.')
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return { content: `Directory not found: ${rel || '.'}`, isError: true }
      }
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.name !== '.git')
        .map((d) => {
          let dir = d.isDirectory()
          if (d.isSymbolicLink()) {
            try {
              dir = statSync(`${abs}/${d.name}`).isDirectory()
            } catch {
              dir = false
            }
          }
          return dir ? `${d.name}/` : d.name
        })
        .sort((x, y) => x.localeCompare(y))
      if (entries.length === 0) return { content: '(empty directory)' }
      const out = entries.slice(0, MAX)
      if (entries.length > MAX) out.push(`... (${entries.length - MAX} more entries not shown)`)
      return { content: out.join('\n') }
    } catch (e) {
      return toolError(e)
    }
  }
}
