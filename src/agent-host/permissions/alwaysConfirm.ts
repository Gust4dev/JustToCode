/** Comandos que sempre pedem confirmação, mesmo em allow-all ou com regra lembrada. */
export const ALWAYS_CONFIRM: RegExp[] = [
  /\bgit\s+push\b[^\n]*(\s--force(-with-lease)?\b|\s-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /(^|[;&|]\s*)(format|diskpart|shutdown)(\.exe)?\b/i,
  /\breg(\.exe)?\s+delete\b/i,
  /\b(Remove-Item|rm|rmdir|rd|del)\b[^\n]*(\s-Recurse\b|\s-r\b|\s-rf\b|\s\/s\b)/i
]

export function needsAlwaysConfirm(command: string): boolean {
  return ALWAYS_CONFIRM.some((re) => re.test(command))
}
