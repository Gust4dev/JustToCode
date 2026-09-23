import { existsSync, statSync } from 'node:fs'
import type { Tool, ToolResult } from './types'
import { resolveInside } from './pathGuard'
import { runRg, toRootRel } from './ripgrep'
import { toolError } from './util'

const MAX = 500

interface Args {
  pattern: string
  path?: string
}

export const globTool: Tool<Args> = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/index.tsx"). Respects .gitignore. ' +
    'Returns up to 500 sorted paths relative to the project root.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match file paths.' },
      path: {
        type: 'string',
        description: 'Directory to search in, relative to the project root (default: root).'
      }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  kind: 'read',
  summarize: (a) => `glob ${a.pattern}`,
  async run(a, ctx): Promise<ToolResult> {
    try {
      const { abs, rel } = resolveInside(ctx.projectRoot, a.path ?? '.')
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return { content: `Directory not found: ${rel || '.'}`, isError: true }
      }
      // Coleta um pouco além do limite para ordenar antes de cortar.
      const r = await runRg(
        ['--files', '--no-require-git', '--glob', a.pattern, '--glob', '!.git'],
        abs,
        ctx.signal,
        MAX * 20
      )
      if (r.code === 2 && r.lines.length === 0) {
        return { content: `ripgrep error: ${r.stderr}`, isError: true }
      }
      const files = r.lines
        .filter(Boolean)
        .map((l) => toRootRel(l, rel))
        .sort()
      if (files.length === 0) return { content: '(no matches)' }
      const out = files.slice(0, MAX)
      if (files.length > MAX || r.truncated) {
        out.push(`... (results truncated to ${MAX} paths; refine the pattern)`)
      }
      return { content: out.join('\n') }
    } catch (e) {
      return toolError(e)
    }
  }
}
