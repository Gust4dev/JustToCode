import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, ChatMessage } from '@shared/domain'
import { RpcError } from '@shared/rpc'
import { git } from '../attribution/git'
import type { ModelClient } from '../model/types'

export const MAX_DIFF_CHARS = 60_000
export const MAX_UNTRACKED_FILES = 20
export const MAX_UNTRACKED_LINES = 50
export const LOG_EXAMPLES = 20

export interface CommitContext {
  staged: boolean
  stat: string
  diff: string
  untracked: string
  log: string[]
}

async function out(root: string, args: string[]): Promise<string> {
  const r = await git(root, args)
  return r.code === 0 ? r.stdout.toString('utf8') : ''
}

/** Corta o diff por arquivo até `max` caracteres, avisando o que ficou de fora. */
export function truncateDiff(diff: string, max = MAX_DIFF_CHARS): string {
  if (diff.length <= max) return diff
  const sections = diff.split(/(?=^diff --git )/m)
  const parts: string[] = []
  const skipped: string[] = []
  let used = 0
  for (const s of sections) {
    const name = /^diff --git a\/(.*?) b\//.exec(s)?.[1] ?? '(unknown)'
    const remaining = max - used
    if (skipped.length === 0 && s.length <= remaining) {
      parts.push(s)
      used += s.length
    } else if (skipped.length === 0 && remaining > 500) {
      // Primeiro arquivo que não cabe: entra cortado, com aviso.
      const cut = s.slice(0, remaining - 200)
      parts.push(
        `${cut}\n[... diff of ${name} truncated: ${s.length - cut.length} more characters]\n`
      )
      used = max
    } else {
      skipped.push(name)
    }
  }
  if (skipped.length > 0)
    parts.push(`\n[... diff omitted for ${skipped.length} file(s): ${skipped.join(', ')}]\n`)
  return parts.join('')
}

async function untrackedPreview(root: string): Promise<string> {
  const list = (await out(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
  if (list.length === 0) return ''
  const blocks: string[] = []
  for (const rel of list.slice(0, MAX_UNTRACKED_FILES)) {
    let body: string
    try {
      const buf = readFileSync(join(root, rel))
      if (buf.includes(0)) body = '(binary file)'
      else {
        const lines = buf.toString('utf8').split(/\r?\n/)
        body = lines.slice(0, MAX_UNTRACKED_LINES).join('\n')
        if (lines.length > MAX_UNTRACKED_LINES)
          body += `\n[... ${lines.length - MAX_UNTRACKED_LINES} more lines]`
      }
    } catch {
      body = '(unreadable)'
    }
    blocks.push(`--- new file: ${rel}\n${body}`)
  }
  if (list.length > MAX_UNTRACKED_FILES)
    blocks.push(`[... ${list.length - MAX_UNTRACKED_FILES} more untracked file(s) not shown]`)
  return blocks.join('\n\n')
}

/** Coleta staged (prioridade) ou working tree + não rastreados. Nunca altera o repo. */
export async function collectCommitContext(root: string): Promise<CommitContext> {
  const diffArgs = ['--no-color', '--no-ext-diff']
  const log = (await out(root, ['log', `-${LOG_EXAMPLES}`, '--pretty=%s']))
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')

  const stagedDiff = await out(root, ['diff', '--cached', ...diffArgs])
  if (stagedDiff.trim() !== '') {
    const stat = await out(root, ['diff', '--cached', '--stat', ...diffArgs])
    return { staged: true, stat, diff: truncateDiff(stagedDiff), untracked: '', log }
  }

  const workDiff = await out(root, ['diff', ...diffArgs])
  const untracked = await untrackedPreview(root)
  if (workDiff.trim() === '' && untracked === '')
    throw new RpcError('Nada para commitar', 'NOTHING_TO_COMMIT')
  const stat = workDiff.trim() === '' ? '' : await out(root, ['diff', '--stat', ...diffArgs])
  return { staged: false, stat, diff: truncateDiff(workDiff), untracked, log }
}

const SYSTEM = `You write git commit messages.
Answer with ONLY the commit message: no explanation, no code fences, no quotes.
Format:
- First line: a title of at most 72 characters.
- Then, optionally, a blank line and a short body with "- " bullets.
Follow the convention seen in the recent commit titles (use Conventional Commits, e.g. "feat: ...", if the history uses it).
Write in the same language as the recent commit titles (English if there is no history).
Describe what changed and why, based only on the diff.`

export function buildCommitPrompt(c: CommitContext): ChatMessage[] {
  const parts: string[] = []
  parts.push(
    `<recent_commit_titles>\n${c.log.length ? c.log.join('\n') : '(no commits yet)'}\n</recent_commit_titles>`
  )
  parts.push(
    c.staged
      ? 'The changes below are staged.'
      : 'Nothing is staged; the changes below are in the working tree (including untracked files).'
  )
  if (c.stat.trim()) parts.push(`<stat>\n${c.stat.trimEnd()}\n</stat>`)
  if (c.diff.trim()) parts.push(`<diff>\n${c.diff.trimEnd()}\n</diff>`)
  if (c.untracked) parts.push(`<untracked_files>\n${c.untracked}\n</untracked_files>`)
  parts.push('Write the commit message for these changes. Answer only with the message.')
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: parts.join('\n\n') }
  ]
}

/** Remove cercas ``` e aspas externas da resposta do modelo. */
export function cleanCommitMessage(raw: string): string {
  let t = raw.trim()
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t)
  if (fence) t = fence[1].trim()
  for (const q of ['"', "'", '`']) {
    if (t.length >= 2 && t.startsWith(q) && t.endsWith(q)) t = t.slice(1, -1).trim()
  }
  return t
}

export async function generateCommitMessage(d: {
  root: string
  model: ModelClient
  cfg: AppConfig
  signal?: AbortSignal
}): Promise<{ message: string; staged: boolean; model: string }> {
  const ctxInfo = await collectCommitContext(d.root)
  const combo = d.cfg.lightCombo || d.cfg.defaultCombo
  if (!combo) throw new RpcError('Nenhuma combo configurada', 'NO_MODEL')
  let text = ''
  const stream = d.model.stream(
    { model: combo, messages: buildCommitPrompt(ctxInfo), tools: [] },
    d.signal ?? new AbortController().signal
  )
  for await (const ev of stream) if (ev.type === 'text_delta') text += ev.delta
  const message = cleanCommitMessage(text)
  if (!message) throw new RpcError('O modelo não devolveu mensagem', 'EMPTY_RESPONSE')
  return { message, staged: ctxInfo.staged, model: combo }
}
