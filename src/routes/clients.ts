import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { AppError } from '../lib/errors'

export const clientsRouter = Router()

clientsRouter.get('/', validateJwt, async (req, res) => {
  const { role, agent_id, user_id } = req.jwt!

  if (role === 'client') {
    const user = await prisma.user.findUnique({
      where: { id: user_id! },
      select: { id: true, email: true, profile: true, photo_url: true },
    })
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found')
    return res.json([user])
  }

  const links = await prisma.agentClient.findMany({
    where: { agent_id: agent_id! },
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
