import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function buildNotes(subjects) {
  const lines = subjects
    .filter(
      (s) =>
        s &&
        !s.startsWith('Merge ') &&
        !s.startsWith('chore(release)') &&
        !s.includes('[skip release]')
    )
    .map((s) => `- ${s}`)
  return lines.length ? lines.join('\n') : '- Manutenção'
}

// CLI: node scripts/release-notes.mjs <tagAnterior> <tag>
// tagAnterior vazio (primeira release) → histórico inteiro até <tag>.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [prev, tag] = process.argv.slice(2)
  if (!tag) {
    console.error('uso: node scripts/release-notes.mjs <tagAnterior> <tag>')
    process.exit(1)
  }
  const range = prev ? `${prev}..${tag}` : tag
  const out = execFileSync('git', ['log', range, '--pretty=%s'], { encoding: 'utf8' })
  process.stdout.write(buildNotes(out.split('\n').map((s) => s.trim())) + '\n')
}
