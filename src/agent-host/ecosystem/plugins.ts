import { join, resolve } from 'node:path'
import { expandHome, listDirs, mtimeOf } from './paths'

export interface PluginDir {
  marketplace: string
  plugin: string
  /** Pasta da versão em uso (a de maior mtime). */
  dir: string
}

/** Uma pasta que já é o conteúdo do plugin (sem subpasta de versão). */
const PLUGIN_MARKERS = ['skills', 'commands', 'agents', '.claude-plugin']

function isPluginContent(dir: string): boolean {
  const children = new Set(listDirs(dir))
  return PLUGIN_MARKERS.some((m) => children.has(m))
}

/**
 * Plugins em `<raiz>/<marketplace>/<plugin>/<versão>/` (layout do cache do Claude Code).
 * Para cada plugin usa só a versão mais recente (maior mtime da pasta de versão).
 * Acrescenta em `deps` as pastas que decidem a escolha (cache por mtime).
 */
export function listPlugins(pluginRoots: string[], deps: string[]): PluginDir[] {
  const out: PluginDir[] = []
  for (const r of pluginRoots) {
    const root = resolve(expandHome(r))
    deps.push(root)
    for (const marketplace of listDirs(root)) {
      const mdir = join(root, marketplace)
      deps.push(mdir)
      for (const plugin of listDirs(mdir)) {
        const pdir = join(mdir, plugin)
        deps.push(pdir)
        if (isPluginContent(pdir)) {
          out.push({ marketplace, plugin, dir: pdir })
          continue
        }
        let best: { dir: string; mtime: number } | null = null
        for (const version of listDirs(pdir)) {
          if (version.startsWith('.')) continue
          const vdir = join(pdir, version)
          const mtime = mtimeOf(vdir)
          deps.push(vdir)
          if (!best || mtime >= best.mtime) best = { dir: vdir, mtime }
        }
        if (best) out.push({ marketplace, plugin, dir: best.dir })
      }
    }
  }
  return out
}
