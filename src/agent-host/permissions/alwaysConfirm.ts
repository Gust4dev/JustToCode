/** Comandos destrutivos que sempre pedem confirmação, mesmo em allow-all ou com regra lembrada. */
const DESTRUCTIVE: RegExp[] = [
  /\bgit\s+push\b[^\n]*(\s--force(-with-lease)?\b|\s-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /(^|[;&|]\s*)(format|diskpart|shutdown)(\.exe)?\b/i,
  /\breg(\.exe)?\s+delete\b/i,
  /\b(Remove-Item|rm|rmdir|rd|del)\b[^\n]*(\s-Recurse\b|\s-r\b|\s-rf\b|\s\/s\b)/i
]

/**
 * Envio de dados para fora da máquina (possível exfiltração).
 * As flags do curl são sensíveis a maiúsculas (`-F` ≠ `-f`, `-T` ≠ `-t`).
 */
const OUTBOUND: RegExp[] = [
  // curl com corpo/upload: -d, --data*, -T, --upload-file, -F, --form* (inclui flags curtas agrupadas, ex. -sd).
  /\bcurl(\.exe)?\b[^\n]*\s(-[a-zA-Z]*[dTF]|--data[\w-]*|--upload-file|--form[\w-]*)(?=[\s=@'"]|$)/,
  /\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n]*\s-(Method[:\s]+['"]?(Post|Put|Patch)\b|InFile\b|Body\b)/i,
  /(^|[\s;&|(])(scp|s?ftp)(\.exe)?(?=\s|$)/i,
  /\bSend-MailMessage\b/i
]

/** Caminhos com credenciais/segredos: lê-los sempre pede confirmação. */
const SENSITIVE_PATHS: RegExp[] = [
  /(^|[\\/\s"'~=:])\.ssh(?=[\\/\s"']|$)/i,
  /(^|[\\/\s"'~=:])\.aws(?=[\\/\s"']|$)/i,
  /\.git-credentials\b/i,
  /(AppData[\\/]+Roaming|%?APPDATA%?)[\\/]+9router\b/i,
  /(^|[\\/\s"'])Login Data\b/i,
  /(^|[\\/\s"'])Cookies(?=[\\/\s"'-]|$)/,
  /\.kdbx\b/i,
  /(^|[^\w])id_(rsa|ed25519)\b/i
]

/** Todos os padrões de comando que sempre pedem confirmação. */
export const ALWAYS_CONFIRM: RegExp[] = [...DESTRUCTIVE, ...OUTBOUND, ...SENSITIVE_PATHS]

export function needsAlwaysConfirm(command: string): boolean {
  return ALWAYS_CONFIRM.some((re) => re.test(command))
}

/** Caminho que aponta para credenciais/segredos (ex. `.ssh/id_rsa`, `.aws/credentials`). */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(path))
}
