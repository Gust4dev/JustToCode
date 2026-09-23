export type MeterColor = 'green' | 'amber' | 'red'

/** `999` → `999`, `61234` → `61k`, `1_000_000` → `1M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = Math.round(n / 1000)
    return k >= 1000 ? '1M' : `${k}k`
  }
  const m = n / 1_000_000
  const rounded = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10
  return `${rounded}M`
}

/** Cor do medidor pela fração usada (0–1): verde < 50%, âmbar < 70%, vermelha ≥ 70%. */
export function meterColor(pct: number): MeterColor {
  if (pct < 0.5) return 'green'
  if (pct < 0.7) return 'amber'
  return 'red'
}
