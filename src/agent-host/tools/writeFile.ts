import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Tool, ToolResult } from './types'
import { resolveInside } from './pathGuard'
import { captureMeta, countLines, toolError } from './util'

interface Args {
  path: string
  content: string
}

export const writeFileTool: Tool<Args> = {
  name: 'write_file',
  description:
    'Create or overwrite a file with the given content. Parent directories are created as needed. ' +
    'Prefer edit_file for changing part of an existing file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root.' },
      content: { type: 'string', description: 'Full content of the file.' }
    },
    required: ['path', 'content'],
    additionalProperties: false
  },
  kind: 'edit',
  summarize: (a) => `write ${a.path}`,
  async run(a, ctx): Promise<ToolResult> {
    try {
      if (typeof a.content !== 'string') {
        return { content: 'content must be a string.', isError: true }
      }
      const { abs, rel } = resolveInside(ctx.projectRoot, a.path)
      if (rel === '') return { content: 'path must be a file inside the project.', isError: true }
      let before: Buffer | null = null
      if (existsSync(abs)) {
        if (statSync(abs).isDirectory()) {
          return { content: `Path is a directory: ${rel}`, isError: true }
        }
        before = readFileSync(abs)
      }
      mkdirSync(dirname(abs), { recursive: true })
      const after = Buffer.from(a.content, 'utf8')
      writeFileSync(abs, after)
      ctx.capture.recordToolWrite(captureMeta(ctx), rel, before, after)
      return { content: `Wrote ${countLines(a.content)} lines to ${rel}` }
    } catch (e) {
      return toolError(e)
    }
  }
}
