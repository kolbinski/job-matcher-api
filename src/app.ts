import 'express-async-errors'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { AppError } from './lib/errors'
import { healthRouter } from './routes/health'
import { matchRouter } from './routes/match'
import { pipelineRouter } from './routes/pipeline'

export const app = express()

app.use(express.json())

app.use('/v1/health', healthRouter)
app.use('/v1/match', matchRouter)
app.use('/v1/pipeline', pipelineRouter)

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
