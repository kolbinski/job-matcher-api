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
import { offerMatchesRouter } from './routes/offerMatches'
import { userOffersRouter } from './routes/userOffers'
import { syncRouter } from './routes/sync'

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
// 120s timeout for CV generation (Claude)
app.use('/v1/cv', (req, _res, next) => { req.setTimeout(120_000); next() })
app.use('/v1/cv', cvGenerateRouter)

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
