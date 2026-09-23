import { DEFAULT_CONFIG, type AppConfig } from '@shared/domain'

let current: AppConfig = { ...DEFAULT_CONFIG }
const listeners = new Set<(c: AppConfig) => void>()

export function getConfig(): AppConfig {
  return current
}
export function setConfig(c: Partial<AppConfig>): void {
  current = { ...DEFAULT_CONFIG, ...current, ...c }
  listeners.forEach((l) => l(current))
}
export function onConfig(l: (c: AppConfig) => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
