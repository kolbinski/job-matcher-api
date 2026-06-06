import fs from 'fs'
import path from 'path'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'

export const userOffersRouter = Router()

const QuerySchema = z.object({
  client_id: z.string().min(1),
  status: z.string().min(1),
  has_learning_goals: z.enum(['true', 'false']).optional(),
})

userOffersRouter.get('/', validateAgentJwt, async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(422).json({
      error: 'INVALID_REQUEST',
      message: 'Missing required query params: client_id, status',
      issues: parsed.error.issues,
    })
  }

  const { client_id, status, has_learning_goals } = parsed.data
  const agentId = req.agent!.id

  const agentClient = await prisma.agentClient.findUnique({
    where: { agent_id_user_id: { agent_id: agentId, user_id: client_id } },
  })
  if (!agentClient) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Client not linked to this agent' })
  }

  const userOffers = await prisma.userOffer.findMany({
    where: { user_id: client_id, status },
    include: { offer: { select: { title: true, company_name: true, url: true } } },
    orderBy: { matched_at: 'desc' },
  })

  let result = userOffers

  if (has_learning_goals === 'true' && status === 'ai_rejected') {
    const user = await prisma.user.findUnique({
      where: { id: client_id },
      select: { profile_path: true },
    })
    let learningGoals: string[] = []
    if (user?.profile_path) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.resolve(user.profile_path), 'utf-8')) as {
          preferences?: { learning_goals?: string[] }
        }
        learningGoals = (raw.preferences?.learning_goals ?? []).map(g => g.toLowerCase())
      } catch { /* profile unreadable — skip filter */ }
    }
    if (learningGoals.length > 0) {
      result = result.filter(uo =>
        uo.claude_missing_skills.some(sk => learningGoals.includes(sk.toLowerCase()))
      )
    }
  }

  res.json({
    client_id,
    status,
    count: result.length,
    offers: result.map(uo => ({
      user_offer_id: uo.id,
      offer_title: uo.offer.title,
      offer_company: uo.offer.company_name,
      offer_url: uo.offer.url,
      claude_score: uo.claude_score,
      claude_role_fit: uo.claude_role_fit,
      claude_matched_reasons: uo.claude_matched_reasons,
      claude_missing_skills: uo.claude_missing_skills,
      claude_recommended: uo.claude_recommended,
      rejection_reason: uo.rejection_reason,
      matched_at: uo.matched_at,
    })),
  })
})
