import { Router } from 'express'
import type { Offer, Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { validateApiKey } from '../middleware/validateApiKey'
import { rateLimiter } from '../middleware/rateLimiter'
import { extractSalary } from '../services/matchService'
import type { OfferSalary } from '../types/match'

export const pipelineRouter = Router()

const PIPELINE_STATUSES = [
  'pending_apply',
  'applied',
  'recruiter_rejected',
  'offer_received',
  'accepted',
  'client_withdrawn',
  'offer_expired',
] as const

type PipelineStatus = (typeof PIPELINE_STATUSES)[number]

interface PipelineOffer {
  user_offer_id: string
  offer_id: string
  title: string
  company: string
  city: string | null
  url: string | null
  salary: OfferSalary | null
  claude_score: number | null
  claude_role_fit: string | null
  claude_matched_reasons: { pros: string[]; cons: string[] }
  missing_skills: string[]
  claude_recommended: boolean | null
  matched_at: string
}

pipelineRouter.get(
  '/',
  validateApiKey,
  rateLimiter,
  async (req, res) => {
    const userOffers = await prisma.userOffer.findMany({
      where: {
        user_id: req.user!.id,
        status: { in: [...PIPELINE_STATUSES] },
      },
      include: { offer: true },
      orderBy: { matched_at: 'desc' },
    })

    const grouped = Object.fromEntries(
      PIPELINE_STATUSES.map(s => [s, [] as PipelineOffer[]])
    ) as Record<PipelineStatus, PipelineOffer[]>

    for (const uo of userOffers) {
      const status = uo.status as PipelineStatus
      if (!PIPELINE_STATUSES.includes(status)) continue
      grouped[status].push(toPipelineOffer(uo as typeof uo & { offer: Offer }))
    }

    res.json(grouped)
  }
)

function toPipelineOffer(uo: {
  id: string
  offer_id: string
  claude_score: number | null
  claude_role_fit: string | null
  claude_matched_reasons: Prisma.JsonValue
  missing_skills: string[]
  claude_recommended: boolean | null
  matched_at: Date
  offer: Offer
}): PipelineOffer {
  return {
    user_offer_id: uo.id,
    offer_id: uo.offer_id,
    title: uo.offer.title,
    company: uo.offer.company_name,
    city: uo.offer.city,
    url: uo.offer.url,
    salary: extractSalary(uo.offer),
    claude_score: uo.claude_score,
    claude_role_fit: uo.claude_role_fit,
    claude_matched_reasons: uo.claude_matched_reasons as { pros: string[]; cons: string[] },
    missing_skills: uo.missing_skills,
    claude_recommended: uo.claude_recommended,
    matched_at: uo.matched_at.toISOString(),
  }
}
