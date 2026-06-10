import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'

export const subscriptionRouter = Router()

subscriptionRouter.get('/status', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const user = await prisma.user.findUnique({
    where: { id: user_id! },
    select: { subscribed_to: true },
  })

  if (!user) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' })
  }

  return res.json({ subscribed_to: user.subscribed_to })
})
