import { Router } from 'express'
import { prisma } from '../lib/prisma'

export const healthRouter = Router()

// GET /v1/health — per spec: status + offers count + last cronjob timestamp
healthRouter.get('/', async (_req, res) => {
  const [offersCount, latestOffer] = await Promise.all([
    prisma.offer.count({ where: { is_active: true } }),
    prisma.offer.findFirst({
      where: { fetched_at: { not: null } },
      orderBy: { fetched_at: 'desc' },
      select: { fetched_at: true },
    }),
  ])

  res.json({
    status: 'ok',
    offers_count: offersCount,
    last_cronjob: latestOffer?.fetched_at?.toISOString() ?? null,
  })
})
