/** Motivos exibidos na aprovação (flag `always_confirm:<motivo>`). */
export type AlwaysConfirmReason =
  | 'remoção recursiva'
  | 'envio de dados pela rede'
  | 'caminho sensível'
  | 'git destrutivo'
  | 'comando de sistema'

export const ALWAYS_CONFIRM_PREFIX = 'always_confirm:'
export const alwaysConfirmFlag = (reason: AlwaysConfirmReason): string =>
  `${ALWAYS_CONFIRM_PREFIX}${reason}`

const GIT_DESTRUCTIVE: RegExp[] = [
  /\bgit\s+push\b[^\n]*(\s--force(-with-lease)?\b|\s-f\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i
]

const SYSTEM: RegExp[] = [
  /(^|[;&|]\s*)(format|diskpart|shutdown)(\.exe)?\b/i,
  /\breg(\.exe)?\s+delete\b/i
]

const RECURSIVE_REMOVE: RegExp[] = [
  // `git rm` fica de fora aqui (ver abaixo): `git rm -r --cached` só mexe no índice.
  /(?<!\bgit\s+)\b(Remove-Item|rm|rmdir|rd|del)\b[^\n]*(\s-Recurse\b|\s-r\b|\s-rf\b|\s\/s\b)/i,
  /\bgit\s+rm\b(?![^\n]*\s--cached\b)[^\n]*\s-(r|rf|fr)\b/i
]

/** Comandos destrutivos que sempre pedem confirmação, mesmo em allow-all ou com regra lembrada. */
const DESTRUCTIVE: RegExp[] = [...GIT_DESTRUCTIVE, ...SYSTEM, ...RECURSIVE_REMOVE]

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

const REASONS: [AlwaysConfirmReason, RegExp[]][] = [
  ['git destrutivo', GIT_DESTRUCTIVE],
  ['comando de sistema', SYSTEM],
  ['remoção recursiva', RECURSIVE_REMOVE],
  ['envio de dados pela rede', OUTBOUND],
  ['caminho sensível', SENSITIVE_PATHS]
]

/** Motivo pelo qual o comando sempre pede confirmação, ou `null`. */
export function alwaysConfirmReason(command: string): AlwaysConfirmReason | null {
  for (const [reason, res] of REASONS) if (res.some((re) => re.test(command))) return reason
  return null
}

export function needsAlwaysConfirm(command: string): boolean {
  return alwaysConfirmReason(command) !== null
}

/** Caminho que aponta para credenciais/segredos (ex. `.ssh/id_rsa`, `.aws/credentials`). */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATHS.some((re) => re.test(path))
}
