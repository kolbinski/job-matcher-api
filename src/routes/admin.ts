import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'

export const adminRouter = Router()

adminRouter.get('/usage', validateAgentJwt, async (_req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const grouped = await prisma.apiCall.groupBy({
    by: ['user_id'],
    where: { called_at: { gte: thirtyDaysAgo } },
    _sum: { input_tokens: true, output_tokens: true },
    _count: { _all: true },
  })

  if (grouped.length === 0) {
    return res.json({ period: 'last_30_days', users: [] })
  }

  const users = await prisma.user.findMany({
    where: { id: { in: grouped.map(g => g.user_id) } },
    select: { id: true, email: true },
  })

  const emailById = new Map(users.map(u => [u.id, u.email ?? null]))

  const summary = grouped.map(g => {
    const input = g._sum.input_tokens ?? 0
    const output = g._sum.output_tokens ?? 0
    return {
      user_id: g.user_id,
      email: emailById.get(g.user_id) ?? null,
      total_input_tokens: input,
      total_output_tokens: output,
      estimated_cost_usd: parseFloat((input * 0.000003 + output * 0.000015).toFixed(6)),
      calls_count: g._count._all,
      period: 'last_30_days',
    }
  })

  res.json({ period: 'last_30_days', users: summary })
})
