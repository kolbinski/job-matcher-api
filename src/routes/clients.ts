import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'

export const clientsRouter = Router()

clientsRouter.get('/', validateAgentJwt, async (req, res) => {
  const agentId = req.agent!.id

  const links = await prisma.agentClient.findMany({
    where: { agent_id: agentId },
    include: {
      user: { select: { id: true, email: true, profile: true } },
    },
  })

  res.json(links.map(l => {
    const p = l.user.profile as { basic_info?: { first_name?: string; last_name?: string } } | null
    return {
      ...l.user,
      first_name: p?.basic_info?.first_name ?? null,
      last_name: p?.basic_info?.last_name ?? null,
    }
  }))
})
