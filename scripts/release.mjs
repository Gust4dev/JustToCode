import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

// Uso: npm run release -- X.Y.Z
// Faz bump do package.json, commit `chore(release): vX.Y.Z`, tag `vX.Y.Z` e push da branch e da tag.
// O workflow .github/workflows/release.yml reage à tag e publica a Release no GitHub.
const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('uso: npm run release -- X.Y.Z')
  process.exit(1)
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
if (git('status', '--porcelain')) {
  console.error('árvore suja: commite ou descarte antes do release')
  process.exit(1)
}
if (git('tag', '--list', `v${version}`)) {
  console.error(`a tag v${version} já existe`)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
pkg.version = version
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
git('add', 'package.json')
git('commit', '-m', `chore(release): v${version}`)
git('tag', `v${version}`)
git('push')
git('push', 'origin', `v${version}`)
console.log(`v${version} publicada; o GitHub Actions vai gerar a release.`)
