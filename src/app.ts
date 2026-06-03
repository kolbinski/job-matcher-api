import 'express-async-errors'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { AppError } from './lib/errors'
import { healthRouter } from './routes/health'
import { matchRouter } from './routes/match'

export const app = express()

app.use(express.json())

app.use('/v1/health', healthRouter)
app.use('/v1/match', matchRouter)

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message })
    return
  }
  console.error(err)
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' })
})
