import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'

export const agentAiUsageRouter = Router()

agentAiUsageRouter.get('/ai-usage', validateJwt, async (req, res) => {
  if (req.jwt!.role !== 'agent') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Agent access only' })
  }

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const [totalAllTime, totalThisMonth, byType, byModel, byUser] = await Promise.all([
    prisma.aiUsage.aggregate({ _sum: { cost: true } }),
    prisma.aiUsage.aggregate({
      where: { created_at: { gte: startOfMonth } },
      _sum: { cost: true },
    }),
    prisma.aiUsage.groupBy({
      by: ['type'],
      _count: { id: true },
      _sum: { input_tokens: true, output_tokens: true, cost: true },
      orderBy: { _sum: { cost: 'desc' } },
    }),
    prisma.aiUsage.groupBy({
      by: ['model'],
      _count: { id: true },
      _sum: { cost: true },
      orderBy: { _sum: { cost: 'desc' } },
    }),
    prisma.aiUsage.groupBy({
      by: ['user_id', 'email'],
      where: { user_id: { not: null } },
      _sum: { cost: true },
      orderBy: { _sum: { cost: 'desc' } },
      take: 10,
    }),
  ])

  return res.json({
    total_cost_all_time: totalAllTime._sum.cost ?? 0,
    total_cost_this_month: totalThisMonth._sum.cost ?? 0,
    by_type: byType.map(r => ({
      type: r.type,
      count: r._count.id,
      input_tokens: r._sum.input_tokens ?? 0,
      output_tokens: r._sum.output_tokens ?? 0,
      cost: r._sum.cost ?? 0,
    })),
    by_model: byModel.map(r => ({
      model: r.model,
      count: r._count.id,
      cost: r._sum.cost ?? 0,
    })),
    top_users: byUser.map(r => ({
      user_id: r.user_id,
      email: r.email,
      cost: r._sum.cost ?? 0,
    })),
  })
})
