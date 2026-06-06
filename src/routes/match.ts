import { Router } from 'express'
import { validateApiKey } from '../middleware/validateApiKey'
import { rateLimiter } from '../middleware/rateLimiter'
import { MatchRequestSchema } from '../types/match'
import { runMatchForUser } from '../services/matchService'

export const matchRouter = Router()

// Re-export helpers still referenced by other routes/scripts
export { extractSalary, extractAllSalaries, buildStretchOffers } from '../services/matchService'
export type { MatchedPair } from '../services/matchService'

matchRouter.post(
  '/',
  validateApiKey,
  rateLimiter,
  async (req, res) => {
    const parsed = MatchRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      console.error('[match] Validation errors:', JSON.stringify(parsed.error.issues, null, 2))
      return res.status(422).json({ error: 'INVALID_PROFILE', message: 'Invalid request body', issues: parsed.error.issues })
    }

    const { filters, sort, options } = parsed.data
    const result = await runMatchForUser(req.user!.id, {
      ai_scoring: options?.ai_scoring ?? true,
      include_unmatched: options?.include_unmatched ?? false,
      filters,
      sort: sort ? { order: sort.order } : undefined,
    })

    res.json(result)
  }
)
