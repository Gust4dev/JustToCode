import { readFileSync, statSync, type Stats } from 'node:fs'
import { extname } from 'node:path'
import type { Tool, ToolResult } from './types'
import { resolveInside } from './pathGuard'
import { toolError } from './util'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const MAX_BYTES = 2 * 1024 * 1024
const MAX_LINE = 2000
const DEFAULT_LIMIT = 2000

interface Args {
  path: string
  offset?: number
  limit?: number
}

export const readFileTool: Tool<Args> = {
  name: 'read_file',
  description:
    'Read a file from the project. Returns lines prefixed with 1-based line numbers (cat -n format). ' +
    'Use offset/limit to read a range of large files. Images (png, jpg, gif, webp) are attached to the conversation.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root.' },
      offset: { type: 'integer', minimum: 1, description: 'First line to read (1-based).' },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of lines to read (default 2000).'
      }
    },
    required: ['path'],
    additionalProperties: false
  },
  kind: 'read',
  summarize: (a) => `read ${a.path}`,
  async run(a, ctx): Promise<ToolResult> {
    try {
      const { abs, rel } = resolveInside(ctx.projectRoot, a.path)
      let st: Stats
      try {
        st = statSync(abs)
      } catch {
        return { content: `File not found: ${rel}`, isError: true }
      }
      if (st.isDirectory()) {
        return { content: `Path is a directory, not a file: ${rel}`, isError: true }
      }

      const mime = IMAGE_MIME[extname(abs).toLowerCase()]
      if (mime) {
        const blobHash = ctx.blobs.put(readFileSync(abs))
        return { content: `Image attached: ${rel}`, images: [{ mime, blobHash }] }
      }

      const hasRange = a.offset !== undefined || a.limit !== undefined
      if (st.size > MAX_BYTES && !hasRange) {
        return {
          content: `File is too large (${st.size} bytes). Use offset and limit to read a range of lines.`,
          isError: true
        }
      }
      const buf = readFileSync(abs)
      if (buf.subarray(0, 8192).includes(0)) {
        return { content: `Cannot read binary file: ${rel}`, isError: true }
      }
      const lines = buf.toString('utf8').split(/\r?\n/)
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      const start = Math.max(1, Math.floor(a.offset ?? 1))
      const limit = Math.max(1, Math.floor(a.limit ?? DEFAULT_LIMIT))
      const slice = lines.slice(start - 1, start - 1 + limit)
      if (slice.length === 0) {
        return { content: `(no lines: file has ${lines.length} line(s))` }
      }
      const out = slice.map((l, i) => {
        const text = l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '... [line truncated]' : l
        return `${String(start + i).padStart(6, ' ')}\t${text}`
      })
      const end = start - 1 + slice.length
      if (end < lines.length) {
        out.push(`... (${lines.length - end} more line(s); use offset=${end + 1} to continue)`)
      }
      return { content: out.join('\n') }
    } catch (e) {
      return toolError(e)
    }
  }
}
