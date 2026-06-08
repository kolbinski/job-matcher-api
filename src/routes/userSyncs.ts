import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'

export const userSyncsRouter = Router()

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

userSyncsRouter.get('/', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can access sync reports' })
  }

  const parsed = ListQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid query params', issues: parsed.error.issues })
  }

  const syncs = await prisma.userSync.findMany({
    where: { user_id: user_id! },
    orderBy: { created_at: 'desc' },
    take: parsed.data.limit,
    select: { id: true, created_at: true, report: true },
  })

  return res.json({ syncs })
})

userSyncsRouter.get('/:id', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can access sync reports' })
  }

  const { id } = req.params as { id: string }

  const sync = await prisma.userSync.findUnique({
    where: { id },
    select: { id: true, user_id: true, created_at: true, report: true },
  })

  if (!sync) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Sync report not found' })
  }

  if (sync.user_id !== user_id) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Sync report does not belong to this client' })
  }

  return res.json({ id: sync.id, created_at: sync.created_at, report: sync.report })
})
