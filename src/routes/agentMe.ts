import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'

export const agentMeRouter = Router()

agentMeRouter.get('/me', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const agentClient = await prisma.agentClient.findFirst({
    where: { user_id: user_id! },
    include: {
      agent: {
        select: { id: true, first_name: true, last_name: true, email: true, phone: true },
      },
    },
  })

  if (!agentClient) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'No agent assigned to this client' })
  }

  return res.json(agentClient.agent)
})
