import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'

export const notificationsRouter = Router()

notificationsRouter.post('/send', validateJwt, async (req, res) => {
  const { role, agent_id } = req.jwt!
  if (role !== 'agent') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only agents can send notifications' })
  }

  const agent = await prisma.agent.findUnique({
    where: { id: agent_id! },
    select: { first_name: true },
  })
  if (!agent) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Agent not found' })
  }

  const agentClients = await prisma.agentClient.findMany({
    where: { agent_id: agent_id! },
    select: { user_id: true },
  })

  const results: Array<{ user_id: string; notified: number }> = []

  for (const { user_id } of agentClients) {
    const unnotified = await prisma.userOfferStatus.findMany({
      where: {
        client_notified: false,
        status: 'applied',
        user_offer: { user_id },
      },
      select: { id: true },
    })

    if (unnotified.length === 0) continue

    const pushTokens = await prisma.pushToken.findMany({
      where: { user_id },
      select: { token: true },
    })

    if (pushTokens.length > 0) {
      const body = `Your agent ${agent.first_name} applied to ${unnotified.length} new offer${unnotified.length === 1 ? '' : 's'}.`
      const messages = pushTokens.map(pt => ({
        to: pt.token,
        title: 'Homo Digital',
        body,
        data: {},
      }))

      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      })
    }

    await prisma.userOfferStatus.updateMany({
      where: { id: { in: unnotified.map(r => r.id) } },
      data: { client_notified: true },
    })

    results.push({ user_id, notified: unnotified.length })
  }

  return res.json({ ok: true, results })
})
