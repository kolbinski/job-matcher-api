import { prisma } from './prisma'

export type ClaudeModelKey =
  | 'prepare_profile'
  | 'review_profile'
  | 'cv_generation'
  | 'cl_generation'
  | 'matching'
  | 'scan_page_model'
  | 'skill_categorization'

export async function getClaudeModel(key: ClaudeModelKey): Promise<string> {
  const setting = await prisma.settings.findUnique({ where: { key: 'claude_models' } })
  if (setting) {
    let models: Record<string, string>
    try {
      models = JSON.parse(setting.value) as Record<string, string>
    } catch {
      throw new Error(`settings.claude_models contains invalid JSON — fix the value in DB.`)
    }
    if (models[key]) return models[key]
  }
  throw new Error(`Claude model not configured for key: '${key}'. Add it to settings.claude_models in DB.`)
}
