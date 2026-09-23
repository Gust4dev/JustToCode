import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class BlobStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true })
  }

  path(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash.slice(2))
  }

  put(data: Buffer | string): string {
    const buf = typeof data === 'string' ? Buffer.from(data) : data
    const hash = createHash('sha256').update(buf).digest('hex')
    const p = this.path(hash)
    if (existsSync(p)) return hash
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p + '.tmp', buf)
    renameSync(p + '.tmp', p)
    return hash
  }

  has(hash: string): boolean {
    return existsSync(this.path(hash))
  }

  get(hash: string): Buffer | null {
    return this.has(hash) ? readFileSync(this.path(hash)) : null
  }
}
