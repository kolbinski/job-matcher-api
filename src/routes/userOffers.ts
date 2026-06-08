import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'
import { validateJwt } from '../middleware/validateJwt'

export const userOffersRouter = Router()

const QuerySchema = z.object({
  client_id: z.string().min(1).optional(),
  status: z.string().min(1),
  has_learning_goals: z.enum(['true', 'false']).optional(),
  count_only: z.enum(['true', 'false']).optional(),
  source: z.string().optional(),
})

interface SalaryPref {
  type: string
  currency: string
  min: number
}

interface SalaryEntry {
  min: number
  max: number
  currency: string
  type: string
  delta: number
  delta_normalized: number
}

interface ClientProfile {
  learningGoals: string[]
  salaryPrefs: SalaryPref[]
}

async function loadClientProfile(clientId: string): Promise<ClientProfile> {
  const user = await prisma.user.findUnique({
    where: { id: clientId },
    select: { profile: true },
  })
  if (!user?.profile) return { learningGoals: [], salaryPrefs: [] }
  try {
    const raw = user.profile as {
      preferences?: {
        learning_goals?: string[]
        salary?: Array<{ type?: string; currency?: string; min?: number }>
      }
    }
    return {
      learningGoals: (raw.preferences?.learning_goals ?? []).map(g => g.toLowerCase()),
      salaryPrefs: (raw.preferences?.salary ?? [])
        .filter((p): p is SalaryPref => p.type != null && p.currency != null && p.min != null),
    }
  } catch {
    return { learningGoals: [], salaryPrefs: [] }
  }
}

async function loadExchangeRates(): Promise<Record<string, number>> {
  const setting = await prisma.settings.findUnique({ where: { key: 'exchange_rates' } })
  if (!setting) return {}
  try {
    return JSON.parse(setting.value) as Record<string, number>
  } catch {
    return {}
  }
}

function buildSalaryEntries(employmentTypes: unknown, salaryPrefs: SalaryPref[], rates: Record<string, number>): SalaryEntry[] {
  if (salaryPrefs.length === 0) return []
  const types = Array.isArray(employmentTypes)
    ? (employmentTypes as Array<{ from?: number; to?: number; currency?: string; type?: string; unit?: string }>)
    : []
  const entries: SalaryEntry[] = []
  for (const et of types) {
    const { from, to, currency, type: etType, unit } = et
    if (from == null || to == null || !currency || !etType) continue
    const pref = salaryPrefs.find(
      p => p.type.toLowerCase() === etType.toLowerCase() &&
           p.currency.toUpperCase() === currency.toUpperCase()
    )
    if (!pref) continue
    const effectiveTo = unit?.toLowerCase() === 'day' ? to * 20 : to
    const delta = effectiveTo - pref.min
    const rate = currency.toUpperCase() === 'PLN' ? 1 : (rates[currency.toUpperCase()] ?? 1)
    entries.push({ min: from, max: to, currency, type: etType, delta, delta_normalized: Math.round(delta * rate) })
  }
  return entries
}

const StatusBodySchema = z.object({
  status: z.enum([
    'applied',
    'agent_withdrawn',
    'recruiter_rejected',
    'offer_received',
    'accepted',
    'client_withdrawn',
  ]),
})

userOffersRouter.patch('/:id/status', validateAgentJwt, async (req, res) => {
  const { id } = req.params as { id: string }
  const parsed = StatusBodySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid status value' })
  }

  const agentId = req.agent!.id

  const userOffer = await prisma.userOffer.findUnique({
    where: { id },
    select: { id: true, user_id: true },
  })
  if (!userOffer) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'User offer not found' })
  }

  const agentClient = await prisma.agentClient.findUnique({
    where: { agent_id_user_id: { agent_id: agentId, user_id: userOffer.user_id } },
  })
  if (!agentClient) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'User offer does not belong to your client' })
  }

  const updated = await prisma.userOffer.update({
    where: { id },
    data: { status: parsed.data.status },
  })

  await prisma.userOfferStatus.create({
    data: { user_offer_id: id, status: parsed.data.status },
  })

  return res.json(updated)
})

userOffersRouter.get('/', validateJwt, async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(422).json({
      error: 'INVALID_REQUEST',
      message: 'Missing required query param: status',
      issues: parsed.error.issues,
    })
  }

  const { status, has_learning_goals, count_only, source } = parsed.data
  const { role, agent_id, user_id } = req.jwt!

  let clientId: string

  if (role === 'client') {
    clientId = user_id!
  } else {
    if (!parsed.data.client_id) {
      return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Missing required query param: client_id' })
    }
    clientId = parsed.data.client_id

    const agentClient = await prisma.agentClient.findUnique({
      where: { agent_id_user_id: { agent_id: agent_id!, user_id: clientId } },
    })
    if (!agentClient) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Client not linked to this agent' })
    }
  }

  const where = {
    user_id: clientId,
    status,
    ...(source && source !== 'all' ? { offer: { source } } : {}),
  }

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
    const { learningGoals } = await loadClientProfile(clientId)
    const count = learningGoals.length > 0
      ? rows.filter(uo => uo.claude_missing_skills.some(sk => learningGoals.includes(sk.toLowerCase()))).length
      : rows.length
    return res.json({ count })
  }

  const userOffers = await prisma.userOffer.findMany({
    where,
    include: {
      offer: { select: { title: true, company_name: true, url: true, employment_types: true, source: true } },
    },
    orderBy: { matched_at: 'desc' },
  })

  const [{ learningGoals, salaryPrefs }, rates] = await Promise.all([
    loadClientProfile(clientId),
    loadExchangeRates(),
  ])

  let result = userOffers

  if (has_learning_goals === 'true' && status === 'ai_rejected') {
    if (learningGoals.length > 0) {
      result = result.filter(uo =>
        uo.claude_missing_skills.some(sk => learningGoals.includes(sk.toLowerCase()))
      )
    }
  }

  const mapped = result.map(uo => ({
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
    salary: buildSalaryEntries(uo.offer.employment_types, salaryPrefs, rates),
    source: uo.offer.source,
    cv_language: uo.cv_language,
  }))

  mapped.sort((a, b) => {
    const aMax = a.salary.length > 0 ? Math.max(...a.salary.map(s => s.delta_normalized)) : null
    const bMax = b.salary.length > 0 ? Math.max(...b.salary.map(s => s.delta_normalized)) : null
    if (aMax === null && bMax === null) return 0
    if (aMax === null) return 1
    if (bMax === null) return -1
    return bMax - aMax
  })

  res.json({
    client_id: clientId,
    status,
    count: mapped.length,
    offers: mapped,
  })
})
