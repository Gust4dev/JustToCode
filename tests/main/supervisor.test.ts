import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProcessSupervisor,
  checkHealth,
  isAlive,
  killTree,
  LOG_LIMIT
} from '../../src/main/components/supervisor'
import { readPids, writePids } from '../../src/main/components/pids'
import type { ComponentId } from '../../src/shared/components'

// Fixture: imprime linhas e fica vivo. Só PIDs criados por este teste são mortos.
const FIXTURE = `
const n = Number(process.argv[2] || 3)
for (let i = 0; i < n; i++) console.log('linha ' + i)
console.error('erro-stderr')
setInterval(() => {}, 1000)
`
const nodeEnv = { ELECTRON_RUN_AS_NODE: '1' }
// Spawn/kill de processo é lento sob carga (suíte paralela, runner Windows do CI).
const PROC_TIMEOUT = 30_000

let dir: string
let script: string
let pidsFile: string
const extra: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jtc-sup-'))
  script = join(dir, 'fixture.js')
  writeFileSync(script, FIXTURE)
  pidsFile = join(dir, 'components', 'pids.json')
})

afterEach(async () => {
  for (const c of extra.splice(0)) if (c.pid && isAlive(c.pid)) await killTree(c.pid)
  rmSync(dir, { recursive: true, force: true })
}, PROC_TIMEOUT)

function make(): {
  sup: ProcessSupervisor
  statuses: [ComponentId, boolean, number | null][]
  lines: string[]
} {
  const statuses: [ComponentId, boolean, number | null][] = []
  const lines: string[] = []
  const sup = new ProcessSupervisor({
    pidsFile,
    onStatus: (id, running, pid) => statuses.push([id, running, pid]),
    onLog: (_id, line) => lines.push(line)
  })
  return { sup, statuses, lines }
}

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout em waitFor')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const spec = (n = 3): Parameters<ProcessSupervisor['start']>[0] => ({
  id: 'llama',
  command: process.execPath,
  args: [script, String(n)],
  env: nodeEnv,
  healthUrl: 'http://127.0.0.1:1/health'
})

describe('ProcessSupervisor', { timeout: PROC_TIMEOUT }, () => {
  it('start: grava PID, captura stdout/stderr por linha; stop mata e limpa', async () => {
    const { sup, statuses, lines } = make()
    const pid = await sup.start(spec())
    expect(readPids(pidsFile).llama?.pid).toBe(pid)
    expect(sup.managedPid('llama')).toBe(pid)
    await waitFor(() => lines.includes('erro-stderr') && lines.includes('linha 2'))
    expect(sup.logs('llama')).toEqual(expect.arrayContaining(['linha 0', 'linha 1', 'linha 2']))
    expect(statuses[0]).toEqual(['llama', true, pid])

    await expect(sup.start(spec())).rejects.toMatchObject({ code: 'ALREADY_RUNNING' })

    await sup.stop('llama')
    await waitFor(() => !isAlive(pid))
    await waitFor(() => statuses.at(-1)?.[1] === false)
    expect(readPids(pidsFile).llama).toBeUndefined()
    expect(sup.managedPid('llama')).toBeNull()
    expect(statuses.at(-1)).toEqual(['llama', false, null])
  })

  it('ring buffer de logs limitado a LOG_LIMIT linhas', async () => {
    const { sup } = make()
    await sup.start(spec(LOG_LIMIT + 50))
    await waitFor(() => sup.logs('llama').includes(`linha ${LOG_LIMIT + 49}`))
    const logs = sup.logs('llama')
    expect(logs.length).toBeLessThanOrEqual(LOG_LIMIT)
    expect(logs).not.toContain('linha 0')
    await sup.stop('llama')
  })

  it('comando inexistente → SPAWN_FAILED e nada em pids.json', async () => {
    const { sup } = make()
    await expect(
      sup.start({ ...spec(), command: join(dir, 'nao-existe.exe') })
    ).rejects.toMatchObject({ code: 'SPAWN_FAILED' })
    expect(readPids(pidsFile).llama).toBeUndefined()
  })

  it('adoção: pids.json pré-escrito com PID vivo é reconhecido e parado', async () => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...nodeEnv },
      stdio: 'ignore',
      windowsHide: true
    })
    extra.push(child)
    await new Promise((r) => child.once('spawn', r))
    writePids(pidsFile, { '9router': { pid: child.pid!, startedAt: 'x' } })

    const { sup, statuses } = make()
    expect(sup.managedPid('9router')).toBe(child.pid)
    await expect(sup.start({ ...spec(), id: '9router' })).rejects.toMatchObject({
      code: 'ALREADY_RUNNING'
    })
    const exited = new Promise((r) => child.once('exit', r))
    await sup.stopAll()
    await exited
    expect(readPids(pidsFile)['9router']).toBeUndefined()
    expect(statuses).toContainEqual(['9router', false, null])
  })

  it('PID morto em pids.json é limpo', () => {
    writePids(pidsFile, { llama: { pid: 123456, startedAt: 'x' } })
    const sup = new ProcessSupervisor({
      pidsFile,
      onStatus: () => {},
      onLog: () => {},
      isAliveImpl: () => false
    })
    expect(sup.managedPid('llama')).toBeNull()
    expect(JSON.parse(readFileSync(pidsFile, 'utf8'))).toEqual({})
  })

  it('pids.json corrompido → vazio', () => {
    writeFileSync(join(dir, 'bad.json'), '{oops')
    expect(readPids(join(dir, 'bad.json'))).toEqual({})
  })
})

describe('checkHealth', { timeout: PROC_TIMEOUT }, () => {
  let server: Server
  let base: string
  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') res.end('ok')
      else if (req.url === '/slow') setTimeout(() => res.end('tarde'), 1000)
      else {
        res.statusCode = 500
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it('2xx saudável; 500, timeout e conexão recusada não', async () => {
    expect(await checkHealth(`${base}/ok`, 10_000)).toBe(true)
    expect(await checkHealth(`${base}/err`)).toBe(false)
    expect(await checkHealth(`${base}/slow`, 100)).toBe(false)
    expect(await checkHealth('http://127.0.0.1:1/', 500)).toBe(false)
  })
})
