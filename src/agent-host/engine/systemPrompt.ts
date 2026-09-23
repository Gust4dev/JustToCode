export const MAX_INSTRUCTIONS_CHARS = 40_000

export interface SystemPromptInput {
  projectRoot: string
  shell: string
  date: string
  /** Texto das instruções do usuário (AGENTS.md/CLAUDE.md já com imports resolvidos). */
  instructions?: string
  /** Skills disponíveis (só nome e descrição; o corpo vem pela ferramenta `skill`). */
  skills?: { name: string; description: string }[]
  /** Subagentes definidos pelo usuário (além do `general`); vazio = sem seção. */
  subagents?: { name: string; description: string }[]
  /** Instruções do agente quando este chat é um subagente (corpo do arquivo do agente). */
  agentPrompt?: string
}

function instructionsBlock(text: string): string[] {
  const t = text.trim()
  if (!t) return []
  const cut = t.length > MAX_INSTRUCTIONS_CHARS
  return [
    '# User instructions',
    'The user provided these instructions (from AGENTS.md/CLAUDE.md files). Follow them.',
    '',
    cut ? t.slice(0, MAX_INSTRUCTIONS_CHARS) : t,
    ...(cut
      ? [
          '',
          `[Instructions truncated: only the first ${MAX_INSTRUCTIONS_CHARS} characters were included.]`
        ]
      : []),
    ''
  ]
}

function skillsBlock(skills: { name: string; description: string }[]): string[] {
  if (!skills.length) return []
  return [
    '',
    '# Skills',
    'Available skills. Use the skill tool to load one before following it.',
    ...skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}`)
  ]
}

function subagentsBlock(agents: { name: string; description: string }[]): string[] {
  if (!agents.length) return []
  return [
    '',
    '# Subagents',
    'Available subagents for the task tool (besides "general"):',
    ...agents.map((a) => `- ${a.name}: ${a.description.replace(/\s+/g, ' ').trim()}`)
  ]
}

function agentBlock(text: string): string[] {
  const t = text.trim()
  if (!t) return []
  return [
    '',
    '# Subagent instructions',
    'You are running as a subagent. Your final message is returned to the agent that called you.',
    '',
    t
  ]
}

export function buildSystemPrompt(p: SystemPromptInput): string {
  return [
    'You are JustToCode, an autonomous coding agent working inside a software project on the user machine.',
    'You help the user by reading, searching and editing files and by running commands with the available tools.',
    '',
    '# Environment',
    `- Project root: ${p.projectRoot}`,
    '- Operating system: Windows.',
    `- Shell: ${p.shell}. Commands run by the shell tool use PowerShell syntax (e.g. \`Get-ChildItem\`, \`$env:NAME\`, \`;\` to chain commands); do not use bash syntax.`,
    `- Current date: ${p.date}`,
    '',
    ...instructionsBlock(p.instructions ?? ''),
    '# Rules',
    '- Use paths relative to the project root, with forward slashes.',
    '- Always read a file with read_file before changing it with edit_file.',
    '- Prefer edit_file for targeted changes; use write_file for new files or full rewrites.',
    '- Use glob, grep and list_dir to find code instead of guessing file names.',
    '- If a tool output was truncated, use read_tool_output with the id from the notice to see the rest.',
    '- If the user denies an action, do not retry the same action; adapt or ask what to do.',
    '- Be concise. Explain what you changed and why, briefly, when you finish.',
    ...skillsBlock(p.skills ?? []),
    ...subagentsBlock(p.subagents ?? []),
    ...agentBlock(p.agentPrompt ?? '')
  ].join('\n')
}
