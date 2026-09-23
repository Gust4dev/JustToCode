import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { cleanError, isNotImplemented } from './format'

/** Mostra um erro de ação: "não implementado" vira aviso discreto, o resto vira toast de erro. */
export function reportError(e: unknown, what: string): void {
  if (isNotImplemented(e)) toast.info(`${what}: ainda não disponível nesta versão`)
  else toast.error(`${what}: ${cleanError(e)}`)
}

/** Estado de uma ação assíncrona com botão ocupado enquanto roda. */
export function useAction(): {
  busy: string | null
  run(key: string, what: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean>
} {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (
    key: string,
    what: string,
    fn: () => Promise<unknown>,
    ok?: string
  ): Promise<boolean> => {
    setBusy(key)
    try {
      await fn()
      if (ok) toast.success(ok)
      return true
    } catch (e) {
      reportError(e, what)
      return false
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

/**
 * Carrega um recurso da API ao montar. Erro "não implementado" vira `unavailable` (aviso discreto);
 * outros erros ficam em `error`.
 */
export function useLoad<T>(
  fn: (() => Promise<T>) | null,
  deps: unknown[]
): {
  data: T | null
  loading: boolean
  error: string | null
  unavailable: boolean
  reload(): void
} {
  const [tick, setTick] = useState(0)
  const key = JSON.stringify([...deps, tick])
  const [res, setRes] = useState<{
    key: string | null
    data: T | null
    error: string | null
    unavailable: boolean
  }>({ key: null, data: null, error: null, unavailable: false })
  useEffect(() => {
    if (!fn) return
    let alive = true
    fn()
      .then((v) => alive && setRes({ key, data: v, error: null, unavailable: false }))
      .catch((e: unknown) => {
        if (!alive) return
        const ni = isNotImplemented(e)
        setRes((r) => ({ key, data: r.data, error: ni ? null : cleanError(e), unavailable: ni }))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return {
    data: res.data,
    loading: !!fn && res.key !== key,
    error: res.error,
    unavailable: res.unavailable,
    reload: () => setTick((t) => t + 1)
  }
}

/** Abre URL no navegador (o main redireciona `window.open` para `shell.openExternal`). */
export function openExternal(url: string): void {
  window.open(url, '_blank')
}
