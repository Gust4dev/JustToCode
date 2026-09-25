import type { AppConfig, ComboInfo, ModelInfo } from '@shared/domain'
import type { ComboOverrideRepo } from '../repo/comboOverrides'
import type { ModelWindowRepo } from '../repo/modelWindows'
import { defaultRouterDbPath, readRouterCombos } from './routerDb'

export interface ComboResolver {
  info(combo: string): Promise<ComboInfo>
  effectiveWindow(model: string): Promise<{ window: number | null; limitingModel: string | null }>
  /**
   * Janela do primeiro membro não ignorado com janela conhecida (override manual da combo vence).
   * Combo sem membros/janelas conhecidos → `unknownWindowFallback` (model null).
   */
  primaryWindow(combo: string): Promise<{ window: number; model: string | null }>
  /**
   * Janela do modelo que o router reportou: casa com um membro (igualdade ou sufixo após `/`),
   * senão procura em `/v1/models`; null se desconhecida.
   */
  windowForReported(combo: string, reported: string): Promise<number | null>
  invalidate(): void
}

/** Parte depois do primeiro `/` (`cx/gpt-oss` → `gpt-oss`); o próprio id se não houver `/`. */
const afterSlash = (id: string): string => {
  const i = id.indexOf('/')
  return i >= 0 ? id.slice(i + 1) : id
}

/** `reported` corresponde ao membro `member` (igualdade ou sufixo após `/`, nos dois sentidos). */
export function matchesMember(member: string, reported: string): boolean {
  return member === reported || afterSlash(member) === reported || member === afterSlash(reported)
}

const MODELS_TTL_MS = 5 * 60_000
const UNKNOWN_MEMBERS = 'Não consegui ler os membros da combo no 9router. Defina manualmente.'

export function createComboResolver(d: {
  listModels: () => Promise<ModelInfo[]>
  overrides: ComboOverrideRepo
  windows: ModelWindowRepo
  getConfig: () => AppConfig
  now?: () => number
}): ComboResolver {
  const now = d.now ?? Date.now
  let cache: { at: number; models: ModelInfo[] } | null = null

  const models = async (): Promise<ModelInfo[]> => {
    if (cache && now() - cache.at < MODELS_TTL_MS) return cache.models
    const list = await d.listModels()
    cache = { at: now(), models: list }
    return list
  }

  const info = async (combo: string): Promise<ComboInfo> => {
    const cfg = d.getConfig()
    const byId = new Map((await models()).map((m) => [m.id, m]))
    const found = byId.get(combo)
    const override = d.overrides.get(combo)
    const warnings: string[] = []

    // Modelo listado como não-combo usa a si mesmo; combo (ou id desconhecido) resolve membros.
    const isCombo = found ? found.isCombo : true
    let members: string[]
    let source: ComboInfo['source']
    if (!isCombo) {
      members = [combo]
      source = 'model'
    } else if (override?.members) {
      members = override.members
      source = 'manual'
    } else {
      const router = readRouterCombos(cfg.routerDbPath || defaultRouterDbPath())
      const fromDb = router.combos[combo]
      if (fromDb) {
        members = fromDb
        source = 'router-db'
      } else {
        members = []
        source = 'unknown'
        warnings.push(router.error ? `${UNKNOWN_MEMBERS} (${router.error})` : UNKNOWN_MEMBERS)
      }
    }

    const ignored = override?.ignored ?? []
    const windows: Record<string, number | null> = {}
    for (const m of members) windows[m] = d.windows.get(m) ?? byId.get(m)?.contextWindow ?? null

    let effectiveWindow: number | null = null
    let limitingModel: string | null = null
    const active = members.filter((m) => !ignored.includes(m))
    if (active.length === 0) {
      effectiveWindow = cfg.unknownWindowFallback
    } else {
      for (const m of active) {
        let w = windows[m]
        if (w == null) {
          warnings.push(`Janela desconhecida para ${m}.`)
          w = cfg.unknownWindowFallback
        }
        if (effectiveWindow == null || w < effectiveWindow) {
          effectiveWindow = w
          limitingModel = m
        }
      }
    }

    if (override?.windowOverride != null) {
      effectiveWindow = override.windowOverride
      limitingModel = 'manual'
    }

    return {
      combo,
      isCombo,
      members,
      ignored,
      windows,
      effectiveWindow,
      limitingModel,
      source,
      warning: warnings.length ? warnings.join(' ') : null
    }
  }

  return {
    info,
    async effectiveWindow(model) {
      const i = await info(model)
      return { window: i.effectiveWindow, limitingModel: i.limitingModel }
    },
    async primaryWindow(combo) {
      const i = await info(combo)
      const override = d.overrides.get(combo)
      if (override?.windowOverride != null) return { window: override.windowOverride, model: null }
      for (const m of i.members) {
        if (i.ignored.includes(m)) continue
        const w = i.windows[m]
        if (w != null) return { window: w, model: m }
      }
      return { window: d.getConfig().unknownWindowFallback, model: null }
    },
    async windowForReported(combo, reported) {
      const i = await info(combo)
      const member =
        i.members.find((m) => m === reported) ?? i.members.find((m) => matchesMember(m, reported))
      if (member && i.windows[member] != null) return i.windows[member]
      const manual = d.windows.get(reported)
      if (manual != null) return manual
      return (await models()).find((m) => m.id === reported)?.contextWindow ?? null
    },
    invalidate() {
      cache = null
    }
  }
}
