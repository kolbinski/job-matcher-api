import { Router } from 'express'
import type { Offer } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { validateApiKey } from '../middleware/validateApiKey'
import { rateLimiter } from '../middleware/rateLimiter'
import { filterRedFlags } from '../services/redFlagFilter'
import { scoreOffer } from '../services/scoring'
import { generateAiSummary } from '../services/aiSummary'
import { MatchRequestSchema } from '../types/match'
import type {
  MatchResponse,
  MatchedOffer,
  UnmatchedOffer,
  OfferSalary,
  MatchFilters,
} from '../types/match'
import { InvalidProfileError } from '../lib/errors'

export const matchRouter = Router()

matchRouter.post(
  '/',
  validateApiKey,
  rateLimiter,
  async (req, res) => {
    const startTime = Date.now()

    // ── 1. Validate request body ───────────────────────────────────────────
    const parsed = MatchRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new InvalidProfileError(
        parsed.error.issues[0]?.message ?? 'Invalid request body'
      )
    }

    const { profile, filters, sort, options } = parsed.data
    const opts = {
      limit: options?.limit ?? 20,
      include_unmatched: options?.include_unmatched ?? false,
      ai_scoring: options?.ai_scoring ?? true,
    }

    // ── 2. Load offers ─────────────────────────────────────────────────────
    const offers = await prisma.offer.findMany()
    const offerBySlug = new Map(offers.map(o => [o.slug, o]))

    // ── 3. Red flag filter + scoring ───────────────────────────────────────
    const matched: MatchedOffer[] = []
    const unmatched: UnmatchedOffer[] = []

    for (const offer of offers) {
      const rejectionReasons = filterRedFlags(profile, offer)

      if (rejectionReasons.length > 0) {
        if (opts.include_unmatched) {
          unmatched.push(toUnmatchedOffer(offer, rejectionReasons))
        }
        continue
      }

      const scored = scoreOffer(profile, offer)
      matched.push(toMatchedOffer(offer, scored))
    }

    // ── 4. Sort ────────────────────────────────────────────────────────────
    const order = sort?.order ?? 'desc'
    matched.sort((a, b) => (order === 'asc' ? a.score - b.score : b.score - a.score))

    // ── 5. Post-score filters ──────────────────────────────────────────────
    const filteredMatched = applyPostScoreFilters(matched, filters)

    // ── 6. AI summaries for top 10 ─────────────────────────────────────────
    let aiScoring = false

    if (opts.ai_scoring) {
      for (const offer of filteredMatched.slice(0, 10)) {
        const original = offerBySlug.get(offer.slug)
        if (!original) continue
        const summary = await generateAiSummary(
          original,
          offer.score,
          offer.match_reasons,
          offer.missing_skills
        )
        if (summary) {
          offer.ai_summary = summary.aiSummary
          offer.ai_recommendation = summary.aiRecommendation
          aiScoring = true
        }
      }
    }

    // ── 7. Apply limit ─────────────────────────────────────────────────────
    const limitedMatched = filteredMatched.slice(0, opts.limit)

    // ── 8. Log api_calls row ───────────────────────────────────────────────
    const responseMs = Date.now() - startTime
    const call = await prisma.apiCall.create({
      data: {
        user_id: req.user!.id,
        offers_matched: limitedMatched.length,
        offers_total: offers.length,
        response_ms: responseMs,
        status: 'success',
      },
    })

    // ── 9. Return response ─────────────────────────────────────────────────
    const response: MatchResponse = {
      meta: {
        call_id: call.id,
        generated_at: new Date().toISOString(),
        response_ms: responseMs,
        total_offers_scanned: offers.length,
        matched_count: limitedMatched.length,
        unmatched_count: unmatched.length,
        ai_scoring: aiScoring,
      },
      matched: limitedMatched,
      unmatched: opts.include_unmatched ? unmatched : [],
    }

    res.json(response)
  }
)

// ─── helpers ──────────────────────────────────────────────────────────────────

function toMatchedOffer(
  offer: Offer,
  scored: ReturnType<typeof scoreOffer>
): MatchedOffer {
  return {
    slug: offer.slug,
    score: scored.score,
    title: offer.title,
    company: offer.company_name,
    company_size: null,
    company_type: null,
    city: offer.city,
    remote: offer.workplace_type === 'remote',
    hybrid:
      offer.workplace_type === 'hybrid' ||
      offer.workplace_type === 'partly_remote',
    experience_level: offer.experience_level,
    salary: extractSalary(offer),
    match_reasons: scored.matchReasons,
    missing_skills: scored.missingSkills,
    red_flags_found: [],
    ai_summary: null,
    ai_recommendation: null,
    url: offer.url,
    source: offer.source,
    fetched_at: offer.fetched_at?.toISOString() ?? null,
  }
}

function toUnmatchedOffer(offer: Offer, rejectionReasons: string[]): UnmatchedOffer {
  return {
    score: 0,
    title: offer.title,
    company: offer.company_name,
    city: offer.city,
    remote: offer.workplace_type === 'remote',
    salary: extractSalary(offer),
    rejection_reasons: rejectionReasons,
    url: offer.url,
    source: offer.source,
  }
}

interface EmploymentTypeEntry {
  type?: string
  salary?: { from?: number; to?: number; currency?: string }
}

function extractSalary(offer: Offer): OfferSalary | null {
  const types = offer.employment_types as unknown as EmploymentTypeEntry[]
  if (!Array.isArray(types)) return null

  for (const t of types) {
    if (t.type === 'b2b' && t.salary?.from !== undefined && t.salary?.to !== undefined) {
      return { from: t.salary.from, to: t.salary.to, currency: t.salary.currency ?? 'PLN', type: 'b2b' }
    }
  }
  for (const t of types) {
    if (t.salary?.from !== undefined && t.salary?.to !== undefined) {
      return { from: t.salary.from, to: t.salary.to, currency: t.salary.currency ?? 'PLN', type: t.type ?? 'unknown' }
    }
  }
  return null
}

function applyPostScoreFilters(
  offers: MatchedOffer[],
  filters?: MatchFilters
): MatchedOffer[] {
  if (!filters) return offers

  return offers.filter((o) => {
    if (filters.min_score !== undefined && o.score < filters.min_score) return false
    if (filters.remote && !o.remote) return false
    if (filters.hybrid && !o.hybrid) return false
    if (filters.cities && filters.cities.length > 0) {
      const city = o.city?.toLowerCase()
      if (!city || !filters.cities.some((c) => c.toLowerCase() === city)) return false
    }
    if (filters.experience_level && filters.experience_level.length > 0) {
      const level = o.experience_level?.toLowerCase()
      if (!level || !filters.experience_level.includes(level as 'junior' | 'mid' | 'senior' | 'c-level' | 'expert')) return false
    }
    if (filters.sources && filters.sources.length > 0) {
      if (!filters.sources.includes(o.source)) return false
    }
    if (filters.salary_min !== undefined && o.salary) {
      if (o.salary.from < filters.salary_min) return false
    }
    if (filters.salary_max !== undefined && o.salary) {
      if (o.salary.to > filters.salary_max) return false
    }
    return true
  })
}
