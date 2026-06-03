import { Router } from 'express'
import { prisma } from '../lib/prisma'

export const healthRouter = Router()

// GET /v1/health — per spec: status + offers count + last cronjob timestamp
// Returns 'degraded' instead of timing out when the connection pool is exhausted
// (e.g. during bulk upsert with connection_limit=1)
healthRouter.get('/', async (_req, res) => {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('db_timeout')), 5000)
    )

    const [offersCount, latestOffer] = await Promise.race([
      Promise.all([
        prisma.offer.count({ where: { is_active: true } }),
        prisma.offer.findFirst({
          where: { fetched_at: { not: null } },
          orderBy: { fetched_at: 'desc' },
          select: { fetched_at: true },
        }),
      ]),
      timeout,
    ])

    res.json({
      status: 'ok',
      offers_count: offersCount,
      last_cronjob: latestOffer?.fetched_at?.toISOString() ?? null,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown'
    res.json({ status: 'degraded', reason })
  }
})
