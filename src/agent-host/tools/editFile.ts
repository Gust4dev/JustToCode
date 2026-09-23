import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Tool, ToolResult } from './types'
import { resolveInside } from './pathGuard'
import { captureMeta, toolError } from './util'

interface Args {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0
  let i = hay.indexOf(needle)
  while (i !== -1) {
    n++
    i = hay.indexOf(needle, i + needle.length)
  }
  return n
}

export const editFileTool: Tool<Args> = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique ' +
    'unless replace_all is true. Line endings (CRLF/LF) of the file are preserved.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root.' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: {
        type: 'string',
        description: 'Replacement text (must differ from old_string).'
      },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' }
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false
  },
  kind: 'edit',
  summarize: (a) => `edit ${a.path}`,
  async run(a, ctx): Promise<ToolResult> {
    try {
      const { abs, rel } = resolveInside(ctx.projectRoot, a.path)
      if (!existsSync(abs) || statSync(abs).isDirectory()) {
        return { content: `File not found: ${rel}`, isError: true }
      }
      if (a.old_string === a.new_string) {
        return {
          content: 'old_string and new_string are identical; nothing to change.',
          isError: true
        }
      }
      if (!a.old_string) return { content: 'old_string must not be empty.', isError: true }

      const before = readFileSync(abs)
      const original = before.toString('utf8')
      const crlf = original.includes('\r\n')
      const text = crlf ? original.replace(/\r\n/g, '\n') : original
      const oldS = crlf ? a.old_string.replace(/\r\n/g, '\n') : a.old_string
      const newS = crlf ? a.new_string.replace(/\r\n/g, '\n') : a.new_string

      const count = countOccurrences(text, oldS)
      if (count === 0) return { content: `old_string not found in ${rel}.`, isError: true }
      if (count > 1 && !a.replace_all) {
        return {
          content:
            `old_string occurs ${count} times in ${rel}. ` +
            'Provide more context to make it unique or set replace_all to true.',
          isError: true
        }
      }
      let updated: string
      if (a.replace_all) {
        updated = text.split(oldS).join(newS)
      } else {
        const i = text.indexOf(oldS)
        updated = text.slice(0, i) + newS + text.slice(i + oldS.length)
      }
      if (crlf) updated = updated.replace(/\n/g, '\r\n')
      const after = Buffer.from(updated, 'utf8')
      writeFileSync(abs, after)
      ctx.capture.recordToolWrite(captureMeta(ctx), rel, before, after)
      const n = a.replace_all ? count : 1
      return { content: `Edited ${rel} (${n} replacement(s))` }
    } catch (e) {
      return toolError(e)
    }
  }
}
