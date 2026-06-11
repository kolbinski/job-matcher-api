import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'

export const offerMatchesRouter = Router()

const QuerySchema = z.object({
  url: z.string().min(1),
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
}

function loadSalaryPrefs(profile: unknown): SalaryPref[] {
  if (!profile) return []
  try {
    const raw = profile as {
      preferences?: { salary?: Array<{ type?: string; currency?: string; min?: number }> }
    }
    return (raw.preferences?.salary ?? [])
      .filter((p): p is SalaryPref => p.type != null && p.currency != null && p.min != null)
  } catch {
    return []
  }
}

function buildSalaryEntries(employmentTypes: unknown, salaryPrefs: SalaryPref[]): SalaryEntry[] {
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
    entries.push({ min: from, max: to, currency, type: etType, delta: effectiveTo - pref.min })
  }
  return entries
}

offerMatchesRouter.get('/', validateAgentJwt, async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Missing required query param: url' })
  }

  const decodedUrl = decodeURIComponent(parsed.data.url)
  console.log('[offer-matches] decoded url:', decodedUrl)
  // req.agent is guaranteed by validateAgentJwt middleware
  const agentId = req.agent!.id

  const offer = await prisma.offer.findFirst({
    where: { url: decodedUrl },
    select: { id: true, employment_types: true, source: true, is_active: true },
  })
  console.log('[offer-matches] offer found:', offer?.id ?? 'NOT FOUND', '| is_active:', offer?.is_active ?? 'N/A')

  if (!offer) {
    return res.json({ matches: [] })
  }

  const agentClients = await prisma.agentClient.findMany({
    where: { agent_id: agentId },
    select: { user_id: true },
  })
  const clientIds = agentClients.map(c => c.user_id)
  console.log('[offer-matches] agent clients:', clientIds.length)

  if (clientIds.length === 0) {
    return res.json({ matches: [] })
  }

  const allUserOffers = await prisma.userOffer.findMany({
    where: { offer_id: offer.id, user_id: { in: clientIds } },
    select: { id: true, status: true, claude_score: true },
  })
  console.log('[offer-matches] user_offers for this offer:', allUserOffers.length, '| statuses:', allUserOffers.map(u => u.status).join(',') || 'none')

  const userOffers = await prisma.userOffer.findMany({
    where: {
      offer_id: offer.id,
      status: 'pending_apply',
      user_id: { in: clientIds },
      claude_score: { not: null },
    },
    include: {
      user: { select: { id: true, profile: true } },
    },
  })

  res.json({
    matches: userOffers.map(uo => ({
      user_offer_id: uo.id,
      client_id: uo.user.id,
      first_name: (uo.user.profile as { basic_info?: { first_name?: string } } | null)?.basic_info?.first_name ?? null,
      last_name: (uo.user.profile as { basic_info?: { last_name?: string } } | null)?.basic_info?.last_name ?? null,
      claude_score: uo.claude_score,
      claude_role_fit: uo.claude_role_fit,
      claude_matched_reasons: uo.claude_matched_reasons,
      salary: buildSalaryEntries(offer.employment_types, loadSalaryPrefs(uo.user.profile)),
      source: offer.source,
    })),
  })
})
