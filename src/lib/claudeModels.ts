import { prisma } from './prisma'

const DEFAULTS = {
  prepare_profile:  'claude-sonnet-4-6',
  review_profile:   'claude-sonnet-4-6',
  cv_cl_generation: 'claude-sonnet-4-6',
  matching:         'claude-sonnet-4-6',
} as const

type ClaudeModelKey = keyof typeof DEFAULTS

export async function getClaudeModel(key: ClaudeModelKey): Promise<string> {
  try {
    const setting = await prisma.settings.findUnique({ where: { key: 'claude_models' } })
    if (!setting) return DEFAULTS[key]
    const models = JSON.parse(setting.value) as Record<string, string>
    return models[key] ?? DEFAULTS[key]
  } catch {
    return DEFAULTS[key]
  }
}
