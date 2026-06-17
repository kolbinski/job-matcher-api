import { Router } from 'express'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'

export const agentAiUsageRouter = Router()

agentAiUsageRouter.get('/ai-usage', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Client JWT required' })
  }

  const adminUser = await prisma.user.findUnique({
    where: { id: user_id! },
    select: { is_admin: true },
  })
  if (!adminUser?.is_admin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Admin access only' })
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
      by: ['email'],
      where: { email: { not: null } },
      _sum: { cost: true },
      orderBy: { _sum: { cost: 'desc' } },
    }),
  ])

  const filteredByUser = byUser.filter(r =>
    r.email &&
    !r.email.endsWith('@jobmatcher-test.invalid') &&
    !r.email.includes('example.com'),
  ).slice(0, 10)

  const topEmails = filteredByUser.map(r => r.email).filter(Boolean) as string[]
  const byUserModel = topEmails.length > 0
    ? await prisma.aiUsage.groupBy({
        by: ['email', 'model'],
        where: { email: { in: topEmails } },
        _count: { id: true },
        _sum: { input_tokens: true, output_tokens: true, cost: true },
        orderBy: { _sum: { cost: 'desc' } },
      })
    : []

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
    top_users: filteredByUser.map(r => ({
      email: r.email,
      total_cost: r._sum.cost ?? 0,
      by_model: byUserModel
        .filter(m => m.email === r.email)
        .map(m => ({
          model: m.model,
          count: m._count.id,
          input_tokens: m._sum.input_tokens ?? 0,
          output_tokens: m._sum.output_tokens ?? 0,
          cost: m._sum.cost ?? 0,
        })),
    })),
  })
})
