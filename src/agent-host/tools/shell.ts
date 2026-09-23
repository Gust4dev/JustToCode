import { execFile, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Tool, ToolContext, ToolResult } from './types'
import { killTree } from './processTree'

const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 600_000
/** Depois do `exit`, espera no máximo isso pelo `close` (netos podem segurar os pipes). */
const CLOSE_GRACE_MS = 1000
const UTF8_PREFIX =
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; '

let pwshLookup: Promise<boolean> | null = null

function hasPwsh(): Promise<boolean> {
  if (!pwshLookup) {
    pwshLookup = new Promise((resolve) => {
      execFile('where', ['pwsh'], { windowsHide: true }, (err, stdout) =>
        resolve(!err && stdout.trim().length > 0)
      )
    })
  }
  return pwshLookup
}

/** auto: pwsh se `where pwsh` achar, senão powershell.exe. */
export async function resolveShell(pref: 'auto' | 'pwsh' | 'powershell'): Promise<string> {
  if (pref === 'pwsh') return 'pwsh'
  if (pref === 'powershell') return 'powershell.exe'
  return (await hasPwsh()) ? 'pwsh' : 'powershell.exe'
}

interface ShellArgs {
  command: string
  timeout_ms?: number
  description?: string
}

interface RunOutcome {
  output: string
  truncatedBytes: number
  exitCode: number | null
  stopped: 'timeout' | 'cancelled' | null
  timeoutMs: number
  spawnError?: string
}

function runCommand(shell: string, args: ShellArgs, ctx: ToolContext): Promise<RunOutcome> {
  const requested = args.timeout_ms ?? ctx.config.shellTimeoutMs
  const timeoutMs = Math.min(Math.max(1, Math.floor(requested)), MAX_TIMEOUT_MS)

  return new Promise((resolve) => {
    let output = ''
    let storedBytes = 0
    let truncatedBytes = 0
    let stopped: RunOutcome['stopped'] = null
    let spawnError: string | undefined
    let exitCode: number | null = null
    let settled = false

    const append = (text: string): void => {
      if (!text) return
      const bytes = Buffer.byteLength(text, 'utf8')
      if (storedBytes + bytes <= MAX_OUTPUT_BYTES) {
        output += text
        storedBytes += bytes
      } else if (storedBytes < MAX_OUTPUT_BYTES) {
        const room = MAX_OUTPUT_BYTES - storedBytes
        const part = Buffer.from(text, 'utf8').subarray(0, room).toString('utf8')
        output += part
        const partBytes = Buffer.byteLength(part, 'utf8')
        storedBytes += partBytes
        truncatedBytes += bytes - partBytes
      } else {
        truncatedBytes += bytes
      }
      ctx.onOutput(text)
    }

    if (ctx.signal.aborted) {
      resolve({ output, truncatedBytes, exitCode, stopped: 'cancelled', timeoutMs })
      return
    }

    const child = spawn(
      shell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', UTF8_PREFIX + args.command],
      {
        cwd: ctx.projectRoot,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    const outDec = new StringDecoder('utf8')
    const errDec = new StringDecoder('utf8')
    child.stdout.on('data', (b: Buffer) => append(outDec.write(b)))
    child.stderr.on('data', (b: Buffer) => append(errDec.write(b)))

    const stop = (reason: 'timeout' | 'cancelled'): void => {
      if (stopped || settled) return
      stopped = reason
      if (child.pid) void killTree(child.pid)
      else child.kill()
    }

    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const onAbort = (): void => stop('cancelled')
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    let graceTimer: NodeJS.Timeout | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      ctx.signal.removeEventListener('abort', onAbort)
      append(outDec.end())
      append(errDec.end())
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ output, truncatedBytes, exitCode, stopped, timeoutMs, spawnError })
    }

    child.on('error', (err) => {
      spawnError = err.message
      finish()
    })
    child.on('exit', (code) => {
      exitCode = code
      graceTimer = setTimeout(finish, CLOSE_GRACE_MS)
    })
    child.on('close', (code) => {
      if (exitCode === null) exitCode = code
      finish()
    })
  })
}

function formatOutcome(o: RunOutcome): ToolResult {
  let content = o.output
  if (o.truncatedBytes > 0) {
    content += `\n[output truncated: ${o.truncatedBytes} more bytes not shown]`
  }
  if (o.spawnError) {
    return {
      content: `${content}\nFailed to start shell: ${o.spawnError}`.trimStart(),
      isError: true
    }
  }
  if (o.stopped === 'timeout') {
    const secs = Math.round(o.timeoutMs / 100) / 10
    return { content: `${content}\nCommand timed out after ${secs}s`.trimStart(), isError: true }
  }
  if (o.stopped === 'cancelled') {
    return { content: `${content}\nCommand cancelled`.trimStart(), isError: true }
  }
  const code = o.exitCode ?? -1
  return { content: `${content}\n[exit code: ${code}]`, isError: code !== 0 }
}

export const shellTool: Tool<ShellArgs> = {
  name: 'shell',
  kind: 'command',
  description:
    'Run a PowerShell command in the project root (Windows). stdout and stderr are combined. ' +
    'Use for builds, tests, git and other CLI tools. Avoid interactive commands; ' +
    `default timeout is configurable (max ${MAX_TIMEOUT_MS} ms).`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The PowerShell command to run.' },
      timeout_ms: {
        type: 'integer',
        description: `Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS}).`
      },
      description: {
        type: 'string',
        description: 'Short description (5-10 words) of what the command does.'
      }
    },
    required: ['command'],
    additionalProperties: false
  },
  summarize(args: ShellArgs): string {
    const cmd = String(args?.command ?? '')
    return cmd.length > 120 ? cmd.slice(0, 119) + '…' : cmd
  },
  async run(args: ShellArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!args || typeof args.command !== 'string' || !args.command.trim()) {
      return { content: 'Missing required parameter: command', isError: true }
    }
    const shell = await resolveShell(ctx.config.shell)
    const meta = {
      projectId: ctx.projectId,
      projectRoot: ctx.projectRoot,
      chatId: ctx.chatId,
      toolCallId: ctx.toolCallId
    }
    const { result } = await ctx.capture.withCommand(meta, () => runCommand(shell, args, ctx))
    return formatOutcome(result)
  }
}
