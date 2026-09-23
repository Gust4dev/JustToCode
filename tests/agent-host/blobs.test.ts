import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { BlobStore } from '../../src/agent-host/blobs'

describe('BlobStore', () => {
  it('put retorna sha256 e get devolve o conteúdo', () => {
    const s = new BlobStore(mkdtempSync(join(tmpdir(), 'jtc-blob-')))
    const h = s.put('olá')
    expect(h).toBe(createHash('sha256').update('olá').digest('hex'))
    expect(s.get(h)?.toString()).toBe('olá')
    expect(s.path(h)).toContain(join(h.slice(0, 2), h.slice(2)))
  })

  it('deduplica e has funciona', () => {
    const s = new BlobStore(mkdtempSync(join(tmpdir(), 'jtc-blob-')))
    const a = s.put(Buffer.from([1, 2, 3]))
    const b = s.put(Buffer.from([1, 2, 3]))
    expect(a).toBe(b)
    expect(s.has(a)).toBe(true)
    expect(s.get('0'.repeat(64))).toBeNull()
  })

  it('não deixa arquivo temporário para trás', () => {
    const root = mkdtempSync(join(tmpdir(), 'jtc-blob-'))
    const s = new BlobStore(root)
    const h = s.put('x')
    expect(existsSync(s.path(h) + '.tmp')).toBe(false)
  })
})
