import type { Request, Response, NextFunction } from 'express'
import { InvalidApiKeyError, RateLimitError } from '../lib/errors'

interface WindowEntry {
  count: number
  windowStart: number
}

const store = new Map<string, WindowEntry>()
const WINDOW_MS = 60_000
const MAX_REQUESTS = 100

// Purge expired windows every 5 minutes to prevent unbounded map growth
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS
  for (const [key, entry] of store.entries()) {
    if (entry.windowStart < cutoff) store.delete(key)
  }
}, 5 * 60_000).unref()

export function rateLimiter(req: Request, _res: Response, next: NextFunction): void {
  const userId = req.user?.id
  if (!userId) throw new InvalidApiKeyError()

  const now = Date.now()
  const entry = store.get(userId)

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    store.set(userId, { count: 1, windowStart: now })
    return next()
  }

  if (entry.count >= MAX_REQUESTS) {
    throw new RateLimitError()
  }

  entry.count++
  next()
}
