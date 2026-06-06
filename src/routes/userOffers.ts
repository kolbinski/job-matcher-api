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
  count_only: z.enum(['true', 'false']).optional(),
})

async function loadLearningGoals(clientId: string): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: clientId },
    select: { profile_path: true },
  })
  if (!user?.profile_path) return []
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(user.profile_path), 'utf-8')) as {
      preferences?: { learning_goals?: string[] }
    }
    return (raw.preferences?.learning_goals ?? []).map(g => g.toLowerCase())
  } catch {
    return []
  }
}

userOffersRouter.get('/', validateAgentJwt, async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(422).json({
      error: 'INVALID_REQUEST',
      message: 'Missing required query params: client_id, status',
      issues: parsed.error.issues,
    })
  }

  const { client_id, status, has_learning_goals, count_only } = parsed.data
  const agentId = req.agent!.id

  const agentClient = await prisma.agentClient.findUnique({
    where: { agent_id_user_id: { agent_id: agentId, user_id: client_id } },
  })
  if (!agentClient) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Client not linked to this agent' })
  }

  const where = { user_id: client_id, status }

  // count_only=true without has_learning_goals: pure DB count, no data transfer
  if (count_only === 'true' && has_learning_goals !== 'true') {
    const count = await prisma.userOffer.count({ where })
    return res.json({ count })
  }

  // count_only=true with has_learning_goals=true: lean fetch (no offer join), filter in memory
  if (count_only === 'true' && has_learning_goals === 'true' && status === 'ai_rejected') {
    const rows = await prisma.userOffer.findMany({
      where,
      select: { claude_missing_skills: true },
    })
    const learningGoals = await loadLearningGoals(client_id)
    const count = learningGoals.length > 0
      ? rows.filter(uo => uo.claude_missing_skills.some(sk => learningGoals.includes(sk.toLowerCase()))).length
      : rows.length
    return res.json({ count })
  }

  const userOffers = await prisma.userOffer.findMany({
    where,
    include: { offer: { select: { title: true, company_name: true, url: true } } },
    orderBy: { matched_at: 'desc' },
  })

  let result = userOffers

  if (has_learning_goals === 'true' && status === 'ai_rejected') {
    const learningGoals = await loadLearningGoals(client_id)
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
