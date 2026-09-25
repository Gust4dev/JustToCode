import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig, type Chat } from '../../src/shared/domain'
import type { EngineEvent } from '../../src/shared/events'
import { openDb } from '../../src/agent-host/db'
import { BlobStore } from '../../src/agent-host/blobs'
import type { HostContext } from '../../src/agent-host/context'
import { createServices } from '../../src/agent-host/services'
import { createOpenAiClient } from '../../src/agent-host/model/openaiClient'
import { hostHandlers } from '../../src/agent-host/handlers'
import { warmTokenizer } from '../../src/agent-host/context/tokenizer'
import { chunk, startFakeRouter, type FakeRouter, type FakeTurn } from '../helpers/fakeRouter'

const routers: FakeRouter[] = []
afterEach(async () => {
  while (routers.length) await routers.pop()?.close()
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

const CHATS = [1, 2, 3]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstUserText(body: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = body.messages.find((x: any) => x.role === 'user')
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return m.content.map((p: any) => p.text ?? '').join('')
}

/** Roteiro por chat (identificado pela mensagem do usuário): shell → edit_file → texto. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function respond(body: any): FakeTurn | undefined {
  const match = /^chat-(\d)$/.exec(firstUserText(body))
  if (!match) return undefined
  const n = match[1]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const step = body.messages.filter((m: any) => m.role === 'tool').length
  if (step === 0) {
    return {
      chunks: [
        chunk.toolCall(
          0,
          `sh_${n}`,
          'shell',
          JSON.stringify({ command: `Set-Content -Path s${n}.txt -Value 'shell ${n}'` })
        ),
        chunk.finish('tool_calls')
      ]
    }
  }
  if (step === 1) {
    return {
      chunks: [
        chunk.toolCall(
          0,
          `ed_${n}`,
          'edit_file',
          JSON.stringify({ path: `f${n}.txt`, old_string: 'original', new_string: `chat ${n}` })
        ),
        chunk.finish('tool_calls')
      ]
    }
  }
  return { chunks: [chunk.text(`fim ${n}`), chunk.finish('stop'), chunk.usage(10, 2)] }
}

describe('engine multi-chat', () => {
  it('três chats simultâneos no mesmo repo terminam idle, com atribuição certa e host responsivo', async () => {
    const base = mkdtempSync(join(tmpdir(), 'jtc-multi-'))
    const root = join(base, 'repo')
    mkdirSync(root)
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 't@t')
    git(root, 'config', 'user.name', 't')
    git(root, 'config', 'core.autocrlf', 'false')
    for (const n of CHATS) writeFileSync(join(root, `f${n}.txt`), 'original\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'init')

    const router = await startFakeRouter(respond)
    routers.push(router)
    const cfg: AppConfig = {
      ...DEFAULT_CONFIG,
      routerBaseUrl: router.url,
      routerApiKey: 'sk-test',
      defaultCombo: 'fake/combo',
      routerDbPath: join(base, 'no-router.sqlite'),
      instructionFiles: [],
      skillRoots: [],
      commandRoots: [],
      agentRoots: [],
      pluginRoots: [],
      ruleRoots: []
    }
    const db = openDb(join(base, 'db.sqlite'))
    const blobs = new BlobStore(join(base, 'blobs'))
    const events: EngineEvent[] = []
    const ctx: HostContext = { db, blobs, emit: (e) => events.push(e) }
    const services = createServices(ctx, {
      model: createOpenAiClient(() => cfg),
      getConfig: () => cfg,
      retryDelaysMs: [20, 40]
    })
    const project = services.projects.create(root, 'repo')
    const chats: Chat[] = CHATS.map((n) =>
      services.chats.create({
        projectId: project.id,
        title: `c${n}`,
        color: '#fff',
        combo: 'fake/combo',
        permissionMode: 'allow-all'
      })
    )

    // Como o host faz na inicialização: o encoder o200k (~200 ms, síncrono) já está carregado.
    warmTokenizer()

    // Mede a latência de host.ping (atraso do event loop + handler) durante a execução.
    const ping = hostHandlers(ctx)['host.ping'] as () => { ok: boolean }
    const latencies: number[] = []
    let pinging = true
    const pingLoop = (async (): Promise<void> => {
      while (pinging) {
        const t0 = performance.now()
        await new Promise((r) => setTimeout(r, 0))
        expect(ping().ok).toBe(true)
        latencies.push(performance.now() - t0)
        await new Promise((r) => setTimeout(r, 20))
      }
    })()

    await Promise.all(chats.map((c, i) => services.engine.send(c.id, `chat-${CHATS[i]}`, [])))

    const deadline = Date.now() + 50_000
    const finished = (): Set<string> =>
      new Set(
        events
          .filter((e) => e.type === 'turn_finished' || e.type === 'turn_error')
          .map((e) => (e as { chatId: string }).chatId)
      )
    while (finished().size < chats.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    pinging = false
    await pingLoop

    expect(events.filter((e) => e.type === 'turn_error')).toEqual([])
    expect(finished().size).toBe(3)

    // Os três começaram antes de qualquer um avançar para o segundo passo (rodaram juntos).
    const firstThree = router.requests.slice(0, 3).map(firstUserText).sort()
    expect(firstThree).toEqual(['chat-1', 'chat-2', 'chat-3'])
    expect(router.requests).toHaveLength(9)

    // Responsividade sem depender de carga da máquina/CI: mediana < 1 s e nenhum ping > 3 s.
    expect(latencies.length).toBeGreaterThan(0)
    const sorted = [...latencies].sort((x, y) => x - y)
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(1000)
    expect(sorted[sorted.length - 1]).toBeLessThan(3000)

    const all = services.fileChanges.listUnreviewed(project.id)
    CHATS.forEach((n, i) => {
      const chat = chats[i]
      expect(services.chats.get(chat.id)?.status).toBe('idle')
      expect(services.engine.isRunning(chat.id)).toBe(false)
      expect(readFileSync(join(root, `f${n}.txt`), 'utf8')).toBe(`chat ${n}\n`)
      expect(services.toolCalls.listByChat(chat.id).map((t) => t.status)).toEqual(['done', 'done'])

      // edit_file: sempre do chat que editou
      const edits = all.filter((c) => c.path === `f${n}.txt`)
      expect(edits).toHaveLength(1)
      expect(edits[0]).toMatchObject({ origin: 'tool', chatId: chat.id })

      // shell: do próprio chat, ou ambíguo com ele entre os candidatos (comandos sobrepostos)
      const cmd = all.filter((c) => c.path === `s${n}.txt`)
      // (um comando sobreposto pode registrar o mesmo arquivo, sempre como ambíguo)
      expect(cmd.length).toBeGreaterThanOrEqual(1)
      for (const c of cmd) {
        if (c.origin === 'ambiguous') {
          expect(c.chatId).toBeNull()
          expect(c.candidateChatIds).toContain(chat.id)
        } else {
          expect(c).toMatchObject({ origin: 'command', chatId: chat.id })
        }
      }
    })
    // nenhuma mudança atribuída a um chat errado
    for (const c of all) {
      if (!c.chatId) continue
      const n = CHATS[chats.findIndex((x) => x.id === c.chatId)]
      expect([`f${n}.txt`, `s${n}.txt`]).toContain(c.path)
    }
  }, 60_000)
})
