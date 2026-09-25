import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/domain'

export interface SecretCodec {
  encrypt(s: string): string
  decrypt(s: string): string
  available: boolean
}

/** Formato em disco: a chave nunca vai como `routerApiKey`. */
type StoredSettings = Partial<Omit<AppConfig, 'routerApiKey'>> & {
  routerApiKeyEnc?: string
  routerApiKeyPlain?: string
}

const KNOWN_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof AppConfig)[]

/** Valores permitidos de campos enumerados (fora deles, vale o padrão). */
const ENUMS: Partial<Record<keyof AppConfig, readonly string[]>> = {
  reasoningStyle: ['param', 'suffix', 'both']
}

function readStored(file: string): StoredSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as StoredSettings) : {}
  } catch {
    return {}
  }
}

export function loadSettings(file: string, crypto: SecretCodec): AppConfig {
  const stored = readStored(file)
  const config: AppConfig = { ...DEFAULT_CONFIG }
  for (const k of KNOWN_KEYS) {
    if (k === 'routerApiKey') continue
    const v = stored[k]
    const def = DEFAULT_CONFIG[k]
    const ok = Array.isArray(def)
      ? Array.isArray(v) && v.every((x) => typeof x === 'string')
      : v !== undefined && typeof v === typeof def
    const allowed = ENUMS[k]
    if (ok && (!allowed || allowed.includes(v as string))) {
      ;(config as unknown as Record<string, unknown>)[k] = v
    }
  }
  if (typeof stored.routerApiKeyEnc === 'string' && crypto.available) {
    try {
      config.routerApiKey = crypto.decrypt(stored.routerApiKeyEnc)
    } catch {
      config.routerApiKey = ''
    }
  } else if (typeof stored.routerApiKeyPlain === 'string') {
    config.routerApiKey = stored.routerApiKeyPlain
  }
  return config
}

export function saveSettings(
  file: string,
  crypto: SecretCodec,
  patch: Partial<AppConfig>
): AppConfig {
  const next: AppConfig = { ...loadSettings(file, crypto) }
  for (const k of KNOWN_KEYS) {
    const allowed = ENUMS[k]
    if (allowed && !allowed.includes(patch[k] as string)) continue
    if (patch[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = patch[k]
  }
  const { routerApiKey, ...rest } = next
  const stored: StoredSettings = { ...rest }
  if (routerApiKey) {
    if (crypto.available) stored.routerApiKeyEnc = crypto.encrypt(routerApiKey)
    else stored.routerApiKeyPlain = routerApiKey
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(stored, null, 2))
  return next
}

export function electronCodec(): SecretCodec {
  return {
    available: safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64'))
  }
}
