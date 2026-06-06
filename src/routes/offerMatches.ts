import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'

export const offerMatchesRouter = Router()

const QuerySchema = z.object({
  url: z.string().min(1),
})

offerMatchesRouter.get('/', validateAgentJwt, async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Missing required query param: url' })
  }

  const { url } = parsed.data
  const agentId = req.agent!.id

  const offer = await prisma.offer.findFirst({
    where: { url, is_active: true },
    select: { id: true },
  })

  if (!offer) {
    return res.json({ matches: [] })
  }

  // Fetch agent's linked client IDs
  const agentClients = await prisma.agentClient.findMany({
    where: { agent_id: agentId },
    select: { user_id: true },
  })
  const clientIds = agentClients.map(c => c.user_id)

  if (clientIds.length === 0) {
    return res.json({ matches: [] })
  }

  const userOffers = await prisma.userOffer.findMany({
    where: {
      offer_id: offer.id,
      status: 'pending_apply',
      user_id: { in: clientIds },
    },
    include: {
      user: { select: { id: true, first_name: true, last_name: true } },
    },
  })

  res.json({
    matches: userOffers.map(uo => ({
      user_offer_id: uo.id,
      client_id: uo.user.id,
      first_name: uo.user.first_name,
      last_name: uo.user.last_name,
      claude_score: uo.claude_score,
      claude_role_fit: uo.claude_role_fit,
      claude_matched_reasons: uo.claude_matched_reasons,
    })),
  })
})
