import { Router } from 'express'
import type { Offer } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { validateApiKey } from '../middleware/validateApiKey'
import { rateLimiter } from '../middleware/rateLimiter'
import { filterRedFlags } from '../services/redFlagFilter'
import { scoreOffer } from '../services/scoring'
import { evaluateOffers } from '../services/claudeEvaluator'
import { normalizeProfile } from '../services/profileParser'
import { MatchRequestSchema } from '../types/match'
import type { MatchResponse, MatchedOffer, UnmatchedOffer, OfferSalary, MatchFilters } from '../types/match'
import { parseEmploymentTypes } from '../lib/offers'

type MatchedPair = { offer: MatchedOffer; original: Offer }

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
      console.error('[match] Validation errors:', JSON.stringify(parsed.error.issues, null, 2))
      return res.status(422).json({ error: 'INVALID_PROFILE', message: 'Invalid request body', issues: parsed.error.issues })
    }

    const { profile, filters, sort, options } = parsed.data
    const opts = {
      include_unmatched: options?.include_unmatched ?? false,
      ai_scoring: options?.ai_scoring ?? true,
    }

    // ── 2. Normalize profile once (not per offer) ──────────────────────────
    const norm = normalizeProfile(profile)

    // ── 3. Load offers — pre-filter in Postgres by skill overlap ───────────
    // Only fetch offers with at least one matching required skill (or none listed).
    // Avoids loading all 10k rows into Node heap on every request.
    // Empty tech profile → only offers that require no skills can produce a non-zero tech score.
    const candidateTechs = [...norm.techs]
    const whereClause = candidateTechs.length > 0
      ? { OR: [{ required_skills: { isEmpty: true } }, { required_skills: { hasSome: candidateTechs } }] }
      : { required_skills: { isEmpty: true } }

    const offers = await prisma.offer.findMany({ where: whereClause })

    // ── 4. Red flag filter + scoring ───────────────────────────────────────
    const pairs: MatchedPair[] = []
    const unmatched: UnmatchedOffer[] = []

    for (const offer of offers) {
      const rejectionReasons = filterRedFlags(profile, offer)
      if (rejectionReasons.length > 0) {
        if (opts.include_unmatched) unmatched.push(toUnmatchedOffer(offer, rejectionReasons))
        continue
      }
      pairs.push({ offer: toMatchedOffer(offer, scoreOffer(norm, offer)), original: offer })
    }

    // ── 5. Sort ────────────────────────────────────────────────────────────
    const order = sort?.order ?? 'desc'
    pairs.sort((a, b) => order === 'asc' ? a.offer.score - b.offer.score : b.offer.score - a.offer.score)

    // ── 6. Post-score filters ──────────────────────────────────────────────
    const filteredPairs = applyPostScoreFilters(pairs, filters)

    // ── 7. Claude batch evaluation — top 30 pre-filtered offers ───────────
    let aiScoring = false

    if (opts.ai_scoring) {
      const top30 = filteredPairs.slice(0, 30)
      console.log('[match] Calling Claude evaluator for', top30.length, 'offers')
      const claudeResults = await evaluateOffers(profile, top30.map(p => p.original))
      console.log('[match] Claude response received:', claudeResults?.length, 'evaluations')
      if (claudeResults) {
        aiScoring = true
        for (let i = 0; i < top30.length; i++) {
          const ev = claudeResults[i]
          if (!ev) continue
          const offer = top30[i].offer
          if (ev.matched_reasons.length > 0) offer.matched_reasons = ev.matched_reasons
          if (ev.missing_skills.length > 0) offer.missing_skills = ev.missing_skills
          offer.ai_rank = ev.rank
          offer.salary_comparison = ev.salary_comparison
          offer.role_fit = ev.role_fit
          offer.recommended = ev.recommended
        }
      }
    }

    // ── 8. Return all scored offers ────────────────────────────────────────
    const limitedMatched = filteredPairs.map(p => p.offer)

    // ── 9. Log api_calls row ───────────────────────────────────────────────
    const responseMs = Date.now() - startTime
    const call = await prisma.apiCall.create({
      data: {
        user_id: req.user!.id, // guaranteed by validateApiKey middleware
        offers_matched: limitedMatched.length,
        offers_total: offers.length,
        response_ms: responseMs,
        status: 'success',
      },
    })

    // ── 10. Return response ────────────────────────────────────────────────
    res.json({
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
    } satisfies MatchResponse)
  }
)

// ─── helpers ──────────────────────────────────────────────────────────────────

function toMatchedOffer(offer: Offer, scored: ReturnType<typeof scoreOffer>): MatchedOffer {
  return {
    score: scored.score,
    title: offer.title,
    company: offer.company_name,
    city: offer.city,
    remote: offer.workplace_type === 'remote',
    hybrid: offer.workplace_type === 'hybrid' || offer.workplace_type === 'partly_remote',
    experience_level: offer.experience_level,
    salary: extractSalary(offer),
    matched_reasons: scored.matchReasons,
    missing_skills: scored.missingSkills,
    red_flags_found: [],
    ai_rank: null,
    salary_comparison: null,
    role_fit: null,
    recommended: null,
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
    hybrid: offer.workplace_type === 'hybrid' || offer.workplace_type === 'partly_remote',
    salary: extractSalary(offer),
    rejection_reasons: rejectionReasons,
    required_skills: offer.required_skills,
    url: offer.url,
    source: offer.source,
  }
}

function extractSalary(offer: Offer): OfferSalary | null {
  const types = parseEmploymentTypes(offer)
  if (types.length === 0) return null

  // Prefer B2B; from/to are top-level fields (no nested salary object)
  for (const t of types) {
    if (t.type === 'b2b' && t.from !== undefined && t.to !== undefined) {
      return { from: t.from, to: t.to, currency: t.currency ?? 'PLN', type: 'b2b' }
    }
  }
  for (const t of types) {
    if (t.from !== undefined && t.to !== undefined) {
      return { from: t.from, to: t.to, currency: t.currency ?? 'PLN', type: t.type ?? 'unknown' }
    }
  }
  return null
}

function applyPostScoreFilters(pairs: MatchedPair[], filters?: MatchFilters): MatchedPair[] {
  if (!filters) return pairs

  return pairs.filter(({ offer: o }) => {
    if (filters.min_score !== undefined && o.score < filters.min_score) return false
    if (filters.remote && !o.remote) return false
    if (filters.hybrid && !o.hybrid) return false
    if (filters.cities?.length) {
      const city = o.city?.toLowerCase()
      if (!city || !filters.cities.some((c) => c.toLowerCase() === city)) return false
    }
    if (filters.experience_level?.length) {
      const level = o.experience_level?.toLowerCase()
      if (!level || !filters.experience_level.includes(level as 'junior' | 'mid' | 'senior' | 'c-level' | 'expert')) return false
    }
    if (filters.sources?.length && !filters.sources.includes(o.source)) return false
    if (filters.salary_min !== undefined && o.salary && o.salary.from < filters.salary_min) return false
    if (filters.salary_max !== undefined && o.salary && o.salary.to > filters.salary_max) return false
    return true
  })
}
