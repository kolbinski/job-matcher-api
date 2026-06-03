import 'express-async-errors'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { AppError } from './lib/errors'

export const app = express()

app.use(express.json())

// Routes registered here in Step 3+

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message })
    return
  }
  console.error(err)
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' })
})
