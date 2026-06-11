import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import type { Request, Response, NextFunction } from 'express'
import { AppError } from './lib/errors'
import { healthRouter } from './routes/health'
import { matchRouter } from './routes/match'
import { pipelineRouter } from './routes/pipeline'
import { authRouter } from './routes/auth'
import { agentAuthRouter } from './routes/agentAuth'
import { clientsRouter } from './routes/clients'
import { cvGenerateRouter } from './routes/cvGenerate'
import { clGenerateRouter } from './routes/clGenerate'
import { offerMatchesRouter } from './routes/offerMatches'
import { userOffersRouter } from './routes/userOffers'
import { syncRouter } from './routes/sync'
import { prospectsRouter } from './routes/prospects'
import { pushTokensRouter } from './routes/pushTokens'
import { notificationsRouter } from './routes/notifications'
import { agentMeRouter } from './routes/agentMe'
import { userSyncsRouter } from './routes/userSyncs'
import { settingsRouter } from './routes/settings'
import { feedbackRouter } from './routes/feedback'
import { subscriptionRouter } from './routes/subscription'
import { onboardingRouter } from './routes/onboarding'
import { skillsRouter } from './routes/skills'
import { skillCategoriesRouter } from './routes/skillCategories'

export const app = express()

app.use(cors())
app.use(express.json())

app.use('/v1/health', healthRouter)
app.use('/v1/match', matchRouter)
app.use('/v1/pipeline', pipelineRouter)
app.use('/v1/auth', authRouter)
app.use('/v1/auth/agent', agentAuthRouter)
app.use('/v1/clients', clientsRouter)
app.use('/v1/offer-matches', offerMatchesRouter)
app.use('/v1/user-offers', userOffersRouter)
// 300s timeout for sync (runs match pipeline per client)
app.use('/v1/sync', (req, _res, next) => { req.setTimeout(300_000); next() })
app.use('/v1/sync', syncRouter)
// 120s timeout for CV/CL generation (Claude + Gotenberg)
app.use('/v1/cv', (req, _res, next) => { req.setTimeout(120_000); next() })
app.use('/v1/cv', cvGenerateRouter)
app.use('/v1/cl', (req, _res, next) => { req.setTimeout(120_000); next() })
app.use('/v1/cl', clGenerateRouter)
app.use('/v1/prospects', prospectsRouter)
app.use('/v1/push-tokens', pushTokensRouter)
app.use('/v1/notifications', notificationsRouter)
app.use('/v1/agent', agentMeRouter)
app.use('/v1/user-syncs', userSyncsRouter)
app.use('/v1/settings', settingsRouter)
app.use('/v1/feedback', feedbackRouter)
app.use('/v1/subscription', subscriptionRouter)
app.use('/v1/skill-categories', skillCategoriesRouter)
app.use('/v1/skills', skillsRouter)
// 120s timeout for onboarding PDF parse + Claude
app.use('/v1/onboarding', (req, _res, next) => { req.setTimeout(120_000); next() })
app.use('/v1/onboarding', onboardingRouter)

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  if (process.env.NODE_ENV === 'development') {
    console.error(err)
  } else {
    console.error('[app] Unhandled error:', message)
  }
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' })
})
