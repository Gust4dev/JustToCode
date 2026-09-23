import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveShell, shellTool } from '../../src/agent-host/tools/shell'
import { killTree } from '../../src/agent-host/tools/processTree'
import { commandTools } from '../../src/agent-host/tools/commandTools'
import type { ToolContext } from '../../src/agent-host/tools/types'
import type { CaptureMeta, ChangeCapture } from '../../src/agent-host/services/types'

const isWin = process.platform === 'win32'
const spawnedPids = new Set<number>()
let root: string

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isAlive(pid)
}

function makeCtx(over: Partial<ToolContext> = {}): {
  ctx: ToolContext
  chunks: string[]
  withCommandCalls: CaptureMeta[]
} {
  const chunks: string[] = []
  const withCommandCalls: CaptureMeta[] = []
  const capture: ChangeCapture = {
    recordToolWrite: () => null,
    async withCommand(m, fn) {
      withCommandCalls.push(m)
      const result = await fn()
      return { result, changes: [] }
    }
  }
  const ctx: ToolContext = {
    projectId: 'p1',
    projectRoot: root,
    chatId: 'c1',
    toolCallId: 't1',
    signal: new AbortController().signal,
    blobs: {} as unknown as ToolContext['blobs'],
    capture,
    config: { shell: 'auto', shellTimeoutMs: 60_000 },
    onOutput: (d) => {
      chunks.push(d)
      for (const m of d.matchAll(/(?:SHELL|CHILD):(\d+)/g)) spawnedPids.add(Number(m[1]))
    },
    ...over
  }
  return { ctx, chunks, withCommandCalls }
}

const SPAWN_CHILD =
  "Write-Output \"SHELL:$PID\"; $p = Start-Process ping -ArgumentList '-n','300','127.0.0.1' " +
  '-WindowStyle Hidden -PassThru; Write-Output "CHILD:$($p.Id)"; Start-Sleep 60'

describe.skipIf(!isWin)('shell tool', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'jtc-shell-'))
  })

  afterAll(async () => {
    for (const pid of spawnedPids) await killTree(pid)
    for (const pid of spawnedPids) expect(await waitDead(pid)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('resolveShell respeita a preferência', async () => {
    expect(await resolveShell('pwsh')).toBe('pwsh')
    expect(await resolveShell('powershell')).toBe('powershell.exe')
    expect(['pwsh', 'powershell.exe']).toContain(await resolveShell('auto'))
  })

  it('exporta commandTools e summarize corta em 120 chars', () => {
    expect(commandTools).toContain(shellTool)
    expect(shellTool.kind).toBe('command')
    expect(shellTool.summarize({ command: 'npm test' })).toBe('npm test')
    expect(shellTool.summarize({ command: 'x'.repeat(300) }).length).toBeLessThanOrEqual(120)
  })

  it('echo com saída, acentos, cwd e código 0; usa withCommand', async () => {
    const { ctx, withCommandCalls } = makeCtx()
    const r = await shellTool.run(
      { command: 'Write-Output "olá ação çé"; Write-Output (Get-Location).Path' },
      ctx
    )
    expect(r.isError).toBe(false)
    expect(r.content).toContain('olá ação çé')
    expect(r.content.toLowerCase()).toContain(root.toLowerCase())
    expect(r.content.endsWith('\n[exit code: 0]')).toBe(true)
    expect(withCommandCalls).toEqual([
      { projectId: 'p1', projectRoot: root, chatId: 'c1', toolCallId: 't1' }
    ])
  }, 30_000)

  it('stderr entra na saída e GIT_TERMINAL_PROMPT=0', async () => {
    const { ctx } = makeCtx()
    const r = await shellTool.run(
      {
        command: '[Console]::Error.WriteLine("erro çã"); Write-Output "G=$env:GIT_TERMINAL_PROMPT"'
      },
      ctx
    )
    expect(r.content).toContain('erro çã')
    expect(r.content).toContain('G=0')
  }, 30_000)

  it('exit 3 → isError e [exit code: 3]', async () => {
    const { ctx } = makeCtx()
    const r = await shellTool.run({ command: 'Write-Output antes; exit 3' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('antes')
    expect(r.content).toContain('[exit code: 3]')
  }, 30_000)

  it('faz streaming antes do fim', async () => {
    const { ctx, chunks } = makeCtx()
    let firstAt = 0
    let sawFirstBeforeSecond = false
    const base = ctx.onOutput
    ctx.onOutput = (d): void => {
      base(d)
      const all = chunks.join('')
      if (!firstAt && all.includes('primeiro')) {
        firstAt = Date.now()
        sawFirstBeforeSecond = !all.includes('segundo')
      }
    }
    const r = await shellTool.run(
      { command: 'Write-Output primeiro; Start-Sleep -Milliseconds 1500; Write-Output segundo' },
      ctx
    )
    expect(sawFirstBeforeSecond).toBe(true)
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(1000)
    expect(r.content).toContain('segundo')
  }, 30_000)

  it('timeout mata a árvore inteira', async () => {
    const { ctx, chunks } = makeCtx()
    const r = await shellTool.run({ command: SPAWN_CHILD, timeout_ms: 5000 }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Command timed out after 5s')
    const out = chunks.join('')
    const shellPid = Number(/SHELL:(\d+)/.exec(out)?.[1])
    const childPid = Number(/CHILD:(\d+)/.exec(out)?.[1])
    expect(shellPid).toBeGreaterThan(0)
    expect(childPid).toBeGreaterThan(0)
    expect(await waitDead(shellPid)).toBe(true)
    expect(await waitDead(childPid)).toBe(true)
  }, 30_000)

  it('abort mata a árvore inteira', async () => {
    const ac = new AbortController()
    const { ctx, chunks } = makeCtx({ signal: ac.signal })
    const base = ctx.onOutput
    ctx.onOutput = (d): void => {
      base(d)
      if (/CHILD:\d+/.test(chunks.join(''))) setTimeout(() => ac.abort(), 200)
    }
    const r = await shellTool.run({ command: SPAWN_CHILD }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Command cancelled')
    const out = chunks.join('')
    const shellPid = Number(/SHELL:(\d+)/.exec(out)?.[1])
    const childPid = Number(/CHILD:(\d+)/.exec(out)?.[1])
    expect(childPid).toBeGreaterThan(0)
    expect(await waitDead(shellPid)).toBe(true)
    expect(await waitDead(childPid)).toBe(true)
  }, 30_000)

  it('killTree ignora PID inexistente', async () => {
    await expect(killTree(999_999_99)).resolves.toBeUndefined()
  })
})
