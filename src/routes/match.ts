import fs from 'fs'
import path from 'path'
import { Router } from 'express'
import type { Offer } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { validateApiKey } from '../middleware/validateApiKey'
import { rateLimiter } from '../middleware/rateLimiter'
import { applyPreFilters } from '../services/redFlagFilter'
import { scoreOffer } from '../services/scoring'
import { evaluateOffers } from '../services/claudeEvaluator'
import { normalizeProfile } from '../services/profileParser'
import { CandidateProfileSchema } from '../types/profile'
import { MatchRequestSchema } from '../types/match'
import type { MatchResponse, MatchedOffer, UnmatchedOffer, OfferSalary, MatchFilters, StretchOffer } from '../types/match'
import { parseEmploymentTypes } from '../lib/offers'

export type MatchedPair = { offer: MatchedOffer; original: Offer }

export const matchRouter = Router()

matchRouter.post(
  '/',
  validateApiKey,
  rateLimiter,
  async (req, res) => {
    const startTime = Date.now()
    const userId = req.user!.id

    // ── 1. Validate request body (filters/sort/options only — no profile) ───
    const parsed = MatchRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      console.error('[match] Validation errors:', JSON.stringify(parsed.error.issues, null, 2))
      return res.status(422).json({ error: 'INVALID_PROFILE', message: 'Invalid request body', issues: parsed.error.issues })
    }

    const { filters, sort, options } = parsed.data
    const opts = {
      include_unmatched: options?.include_unmatched ?? false,
      ai_scoring: options?.ai_scoring ?? true,
    }
    console.log('[match] ai_scoring option:', opts.ai_scoring)

    // ── 2. Load profile from user.profile_path ─────────────────────────────
    const profilePath = req.user!.profile_path
    if (!profilePath) {
      return res.status(422).json({ error: 'INVALID_PROFILE', message: 'No profile configured for this user' })
    }

    let rawProfile: unknown
    try {
      rawProfile = JSON.parse(fs.readFileSync(path.resolve(profilePath), 'utf-8'))
    } catch {
      return res.status(422).json({ error: 'INVALID_PROFILE', message: `Profile file not found: ${profilePath}` })
    }

    const profileParsed = CandidateProfileSchema.safeParse(rawProfile)
    if (!profileParsed.success) {
      return res.status(422).json({ error: 'INVALID_PROFILE', message: 'Profile file is invalid', issues: profileParsed.error.issues })
    }
    const profile = profileParsed.data

    // ── 3. Normalize profile once (not per offer) ──────────────────────────
    const norm = normalizeProfile(profile)

    // ── 4. Exclude offers already processed for this user ─────────────────
    const seenIds = new Set(
      (await prisma.userOffer.findMany({ where: { user_id: userId }, select: { offer_id: true } }))
        .map(r => r.offer_id)
    )

    // ── 5. Load offers — pre-filter in Postgres by skill overlap ───────────
    const candidateTechs = [...norm.techs]
    const skillFilter = candidateTechs.length > 0
      ? { OR: [{ required_skills: { isEmpty: true } }, { required_skills: { hasSome: candidateTechs } }] }
      : { required_skills: { isEmpty: true } }

    const whereClause = {
      AND: [
        { is_active: true },
        skillFilter,
        ...(seenIds.size > 0 ? [{ NOT: { id: { in: [...seenIds] } } }] : []),
      ],
    }

    const offers = await prisma.offer.findMany({ where: whereClause })

    // ── 6. Pre-filter + scoring ────────────────────────────────────────────
    const rejectedForDB: { offer_id: string; reason: string }[] = []
    const pairs: MatchedPair[] = []
    const unmatched: UnmatchedOffer[] = []
    const rejectCounts = { workplace: 0, employment_type: 0, salary: 0, seniority: 0, language: 0, red_flags: 0 }

    for (const offer of offers) {
      const result = applyPreFilters(profile, offer)
      if (!result.pass) {
        if (result.rejectedByWorkplace)      rejectCounts.workplace++
        if (result.rejectedByEmploymentType) rejectCounts.employment_type++
        if (result.rejectedBySalary)         rejectCounts.salary++
        if (result.rejectedBySeniority)      rejectCounts.seniority++
        if (result.rejectedByLanguage)       rejectCounts.language++
        if (result.rejectedByRedFlags)       rejectCounts.red_flags++
        rejectedForDB.push({ offer_id: offer.id, reason: result.reasons[0] ?? '' })
        if (opts.include_unmatched) unmatched.push(toUnmatchedOffer(offer, result.reasons))
        continue
      }
      pairs.push({ offer: toMatchedOffer(offer, scoreOffer(norm, offer)), original: offer })
    }

    // ── Also collect skill-excluded offers (not returned by SQL filter) ───────
    // These have no matching skills — query their IDs and mark as pre_filter_rejected
    // so user_offers gets a complete record of every offer for this user.
    const processedIds = new Set(offers.map(o => o.id))
    const skillExcluded = await prisma.offer.findMany({
      where: { is_active: true, id: { notIn: [...seenIds, ...processedIds] } },
      select: { id: true },
    })
    for (const { id } of skillExcluded) {
      rejectedForDB.push({ offer_id: id, reason: 'No skills match candidate profile' })
    }

    console.log(`[preFilter] workplace: rejected ${rejectCounts.workplace}`)
    console.log(`[preFilter] employment_type: rejected ${rejectCounts.employment_type}`)
    console.log(`[preFilter] salary: rejected ${rejectCounts.salary}`)
    console.log(`[preFilter] seniority: rejected ${rejectCounts.seniority}`)
    console.log(`[preFilter] language: rejected ${rejectCounts.language}`)
    console.log(`[preFilter] red_flags: rejected ${rejectCounts.red_flags}`)
    console.log(`[preFilter] skill_excluded: ${skillExcluded.length}`)
    console.log(`[preFilter] total passed: ${pairs.length} → sending to Claude`)

    // ── 7. Sort ────────────────────────────────────────────────────────────
    const order = sort?.order ?? 'desc'
    pairs.sort((a, b) => order === 'asc' ? a.offer.score - b.offer.score : b.offer.score - a.offer.score)

    // ── 8. Post-score filters ──────────────────────────────────────────────
    const filteredPairs = applyPostScoreFilters(pairs, filters)

    // ── 9. Claude batch evaluation ─────────────────────────────────────────
    let aiScoring = false
    let claudeEvaluationsCount = 0

    if (opts.ai_scoring && filteredPairs.length === 0) {
      console.log('[match] No offers to evaluate — skipping Claude API call')
    } else if (opts.ai_scoring) {
      console.log('[match] Calling Claude evaluator for', filteredPairs.length, 'offers')
      const claudeResults = await evaluateOffers(profile, filteredPairs.map(p => p.original))
      console.log('[match] Claude response received:', claudeResults?.length, 'evaluations')
      if (claudeResults) {
        aiScoring = true
        claudeEvaluationsCount = claudeResults.length

        const claudeBySlug = new Map(
          claudeResults
            .filter(ev => ev.offer_index >= 0 && ev.offer_index < filteredPairs.length)
            .map(ev => [filteredPairs[ev.offer_index].original.slug, ev])
        )

        for (const p of filteredPairs) {
          const claudeData = claudeBySlug.get(p.original.slug)
          if (!claudeData) continue
          p.offer.score = claudeData.score
          p.offer.rank = claudeData.rank
          p.offer.matched_reasons = claudeData.matched_reasons
          p.offer.missing_skills = claudeData.missing_skills
          p.offer.salary_comparison = claudeData.salary_comparison
          p.offer.role_fit = claudeData.role_fit
          p.offer.recommended = claudeData.recommended
        }

        filteredPairs.sort((a, b) => b.offer.score - a.offer.score)
      }
    }

    // ── 9b. Compute stretch_offers ────────────────────────────────────────
    const learningGoals = (profile.preferences.learning_goals ?? []).map(g => g.toLowerCase())
    const stretchOffers = await buildStretchOffers(userId, learningGoals, prisma)

    // ── 10. Write user_offers ──────────────────────────────────────────────
    const now = new Date()

    const preFilterRows = rejectedForDB.map(({ offer_id, reason }) => ({
      user_id: userId,
      offer_id,
      status: 'pre_filter_rejected',
      rejection_reason: reason || null,
      claude_matched_reasons: [] as string[],
      claude_missing_skills: [] as string[],
      matched_at: now,
      updated_at: now,
    }))

    const claudeRows = filteredPairs.map(p => ({
      user_id: userId,
      offer_id: p.original.id,
      status: p.offer.recommended === false ? 'ai_rejected' : 'pending_apply',
      rejection_reason: p.offer.recommended === false ? (p.offer.role_fit ?? null) : null,
      claude_score: p.offer.recommended !== null ? p.offer.score : null,
      claude_role_fit: p.offer.role_fit ?? null,
      claude_matched_reasons: p.offer.matched_reasons,
      claude_missing_skills: p.offer.missing_skills,
      claude_salary_comparison: p.offer.salary_comparison ?? null,
      claude_recommended: p.offer.recommended ?? null,
      matched_at: now,
      updated_at: now,
    }))

    if (preFilterRows.length + claudeRows.length > 0) {
      // skipDuplicates handles the unique(user_id, offer_id) constraint.
      // try/catch guards against FK violations if an offer was deleted between
      // our SELECT and this INSERT (e.g. concurrent sync deleting stale offers).
      try {
        await prisma.userOffer.createMany({
          data: [...preFilterRows, ...claudeRows],
          skipDuplicates: true,
        })
      } catch (err) {
        console.warn('[match] user_offers insert skipped:', err instanceof Error ? err.message : err)
      }
    }

    // ── 11. Log api_calls row ──────────────────────────────────────────────
    const responseMs = Date.now() - startTime
    const call = await prisma.apiCall.create({
      data: {
        user_id: userId,
        offers_matched: filteredPairs.length,
        offers_total: offers.length + skillExcluded.length,
        response_ms: responseMs,
        status: 'success',
      },
    })

    // ── 12. Return response ────────────────────────────────────────────────
    const limitedMatched = filteredPairs.map(p => p.offer)
    if (limitedMatched.length > 0) {
      const first = limitedMatched[0]
      console.log('[match] First offer Claude fields — role_fit:', first.role_fit, '| recommended:', first.recommended)
    }
    res.json({
      meta: {
        call_id: call.id,
        generated_at: new Date().toISOString(),
        response_ms: responseMs,
        total_offers_scanned: offers.length + skillExcluded.length,
        matched_count: limitedMatched.length,
        unmatched_count: unmatched.length,
        ai_scoring: aiScoring,
        claude_evaluations_count: claudeEvaluationsCount,
      },
      matched: limitedMatched,
      unmatched: opts.include_unmatched ? unmatched : [],
      stretch_offers: stretchOffers,
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
    rank: null,
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

export function extractSalary(offer: Offer): OfferSalary | null {
  const types = parseEmploymentTypes(offer)
  if (types.length === 0) return null

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

// learningGoals must already be lowercased by the caller.
// Reads from user_offers history — ai_rejected offers are never re-evaluated by Claude.
export async function buildStretchOffers(
  userId: string,
  learningGoals: string[],
  db: typeof prisma,
): Promise<StretchOffer[]> {
  if (learningGoals.length === 0) return []

  const rows = await db.userOffer.findMany({
    where: { user_id: userId, status: 'ai_rejected' },
    include: { offer: true },
  })

  console.log('[stretch] ai_rejected candidates:', rows.length, 'learning_goals:', learningGoals)

  return rows
    .filter(row => {
      const missing = row.claude_missing_skills.map(s => s.toLowerCase())
      return learningGoals.some(goal => missing.includes(goal))
    })
    .sort((a, b) => (extractSalary(b.offer)?.to ?? 0) - (extractSalary(a.offer)?.to ?? 0))
    .slice(0, 3)
    .map(row => ({
      title: row.offer.title,
      company_name: row.offer.company_name,
      salary: extractSalary(row.offer),
      role_fit: row.claude_role_fit,
      missing_skills: row.claude_missing_skills,
      url: row.offer.url,
    }))
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
