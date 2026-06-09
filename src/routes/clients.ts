import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'

export const clientsRouter = Router()

clientsRouter.get('/', validateAgentJwt, async (req, res) => {
  const agentId = req.agent!.id

  const links = await prisma.agentClient.findMany({
    where: { agent_id: agentId },
    include: {
      user: { select: { id: true, first_name: true, last_name: true, email: true, profile: true } },
    },
  })

  res.json(links.map(l => l.user))
})
