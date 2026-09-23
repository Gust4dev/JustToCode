import type { AppConfig } from '@shared/domain'
import { discoverSkills, findSkill, loadSkillBody } from '../ecosystem/skills'
import type { Tool } from './types'

export const SKILL_TOOL = 'skill'

interface SkillArgs {
  name: string
}

/** Ferramenta `skill`: devolve o corpo (sem frontmatter) de uma skill + a pasta dela. */
export function createSkillTool(getConfig: () => AppConfig): Tool<SkillArgs> {
  return {
    name: SKILL_TOOL,
    kind: 'read',
    description:
      'Load a skill by name (from the Skills list in the system prompt). ' +
      'Returns its instructions and its folder; follow them after loading. ' +
      'Paths mentioned by the skill are relative to that folder.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name.' } },
      required: ['name'],
      additionalProperties: false
    },
    summarize: (a) => `skill ${String(a?.name ?? '')}`,
    async run(args, ctx) {
      const name = typeof args?.name === 'string' ? args.name.trim() : ''
      if (!name) return { content: 'Missing required parameter: name', isError: true }
      const cfg = getConfig()
      const roots = cfg.skillRoots ?? []
      const plugins = cfg.pluginRoots ?? []
      const skill = findSkill(ctx.projectRoot, roots, name, plugins)
      if (!skill) {
        const names = discoverSkills(ctx.projectRoot, roots, plugins).map((s) => s.name)
        return {
          content: `Unknown skill: ${name}. Available skills: ${names.join(', ') || '(none)'}.`,
          isError: true
        }
      }
      try {
        const { body, dir } = loadSkillBody(skill)
        return { content: `Skill "${skill.name}" (folder: ${dir})\n\n${body.trim()}` }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: `Failed to read skill ${name}: ${msg}`, isError: true }
      }
    }
  }
}
