import { existsSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Tool, ToolResult } from './types'
import { resolveInside } from './pathGuard'
import { runRg, toRootRel } from './ripgrep'
import { toolError } from './util'

const MAX = 500

interface Args {
  pattern: string
  path?: string
  glob?: string
  case_insensitive?: boolean
  output_mode?: 'files_with_matches' | 'content'
  context?: number
}

export const grepTool: Tool<Args> = {
  name: 'grep',
  description:
    'Search file contents with a regular expression (ripgrep syntax). Respects .gitignore. ' +
    'output_mode "files_with_matches" (default) lists matching files; "content" shows matching lines ' +
    'as path:line:text. Output is limited to 500 lines.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: {
        type: 'string',
        description: 'File or directory to search, relative to the project root (default: root).'
      },
      glob: { type: 'string', description: 'Only search files matching this glob (e.g. "*.ts").' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive search.' },
      output_mode: {
        type: 'string',
        enum: ['files_with_matches', 'content'],
        description: 'Output format (default files_with_matches).'
      },
      context: {
        type: 'integer',
        minimum: 0,
        description: 'Lines of context around each match (content mode only).'
      }
    },
    required: ['pattern'],
    additionalProperties: false
  },
  kind: 'read',
  summarize: (a) => `grep ${JSON.stringify(a.pattern)}`,
  async run(a, ctx): Promise<ToolResult> {
    try {
      const { abs, rel } = resolveInside(ctx.projectRoot, a.path ?? '.')
      if (!existsSync(abs)) return { content: `Path not found: ${rel || '.'}`, isError: true }
      const isDir = statSync(abs).isDirectory()
      const cwd = isDir ? abs : dirname(abs)
      const target = isDir ? '.' : basename(abs)
      const relDir = isDir ? rel : rel.split('/').slice(0, -1).join('/')

      const mode = a.output_mode ?? 'files_with_matches'
      const args = ['--no-require-git', '--color', 'never', '--glob', '!.git']
      if (a.case_insensitive) args.push('--ignore-case')
      if (a.glob) args.push('--glob', a.glob)
      if (mode === 'content') {
        args.push('--no-heading', '--line-number', '--with-filename')
        if (a.context && a.context > 0) args.push('--context', String(Math.floor(a.context)))
      } else {
        args.push('--files-with-matches')
      }
      args.push('--regexp', a.pattern, '--', target)

      const r = await runRg(args, cwd, ctx.signal, MAX)
      if (r.code === 2 && r.lines.length === 0) {
        return { content: `ripgrep error: ${r.stderr}`, isError: true }
      }
      let lines = r.lines.filter((l) => l !== '')
      if (mode === 'content') {
        lines = lines.map((l) => (l === '--' ? l : toRootRel(l, relDir)))
      } else {
        lines = lines.map((l) => toRootRel(l, relDir)).sort()
      }
      if (lines.length === 0) return { content: '(no matches)' }
      if (r.truncated) lines.push(`... (output truncated to ${MAX} lines; refine the search)`)
      return { content: lines.join('\n') }
    } catch (e) {
      return toolError(e)
    }
  }
}
