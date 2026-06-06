import fs from 'fs'
import path from 'path'
import type { Offer } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { applyPreFilters } from './redFlagFilter'
import { scoreOffer } from './scoring'
import { evaluateOffers } from './claudeEvaluator'
import type { ClaudeEvaluation } from './claudeEvaluator'
import { normalizeProfile } from './profileParser'
import { CandidateProfileSchema } from '../types/profile'
import type { MatchResponse, MatchedOffer, UnmatchedOffer, OfferSalary, MatchFilters, StretchOffer } from '../types/match'
import { parseEmploymentTypes } from '../lib/offers'

export type MatchedPair = { offer: MatchedOffer; original: Offer }

export async function runMatchForUser(
  userId: string,
  opts?: {
    ai_scoring?: boolean
    include_unmatched?: boolean
    filters?: MatchFilters
    sort?: { order?: 'asc' | 'desc' }
  },
): Promise<MatchResponse> {
  const startTime = Date.now()
  const doAiScoring = opts?.ai_scoring ?? true
  const includeUnmatched = opts?.include_unmatched ?? false
  const sortOrder = opts?.sort?.order ?? 'desc'

  // ── 1. Load profile ────────────────────────────────────────────────────────
  const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { profile_path: true } })
  const profilePath = dbUser?.profile_path
  if (!profilePath) throw new AppError(422, 'INVALID_PROFILE', 'No profile configured for this user')

  let rawProfile: unknown
  try {
    rawProfile = JSON.parse(fs.readFileSync(path.resolve(profilePath), 'utf-8'))
  } catch {
    throw new AppError(422, 'INVALID_PROFILE', `Profile file not found: ${profilePath}`)
  }

  const profileParsed = CandidateProfileSchema.safeParse(rawProfile)
  if (!profileParsed.success) throw new AppError(422, 'INVALID_PROFILE', 'Profile file is invalid')
  const profile = profileParsed.data

  // ── 2. Normalize profile once ──────────────────────────────────────────────
  const norm = normalizeProfile(profile)

  // ── 3. Exclude already-processed offers ───────────────────────────────────
  const seenIds = new Set(
    (await prisma.userOffer.findMany({ where: { user_id: userId }, select: { offer_id: true } }))
      .map(r => r.offer_id)
  )

  // ── 4. Load active offers with skill pre-filter ────────────────────────────
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

  // ── 5. Pre-filter + score ──────────────────────────────────────────────────
  const rejectedForDB: { offer_id: string; reason: string }[] = []
  const pairs: MatchedPair[] = []
  const unmatched: UnmatchedOffer[] = []
  const rejectCounts = { workplace: 0, employment_type: 0, salary: 0, seniority: 0, language: 0, red_flags: 0, city: 0 }

  for (const offer of offers) {
    const result = applyPreFilters(profile, offer)
    if (!result.pass) {
      if (result.rejectedByWorkplace)      rejectCounts.workplace++
      if (result.rejectedByEmploymentType) rejectCounts.employment_type++
      if (result.rejectedBySalary)         rejectCounts.salary++
      if (result.rejectedBySeniority)      rejectCounts.seniority++
      if (result.rejectedByLanguage)       rejectCounts.language++
      if (result.rejectedByRedFlags)       rejectCounts.red_flags++
      if (result.rejectedByCity) {
        rejectCounts.city++
      }
      rejectedForDB.push({ offer_id: offer.id, reason: result.reasons[0] ?? '' })
      if (includeUnmatched) unmatched.push(toUnmatchedOffer(offer, result.reasons))
      continue
    }
    pairs.push({ offer: toMatchedOffer(offer, scoreOffer(norm, offer)), original: offer })
  }

  // ── 6. Skill-excluded offers (no SQL skill overlap) ────────────────────────
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
  console.log(`[preFilter] city: rejected ${rejectCounts.city}`)
  console.log(`[preFilter] skill_excluded: ${skillExcluded.length}`)
  console.log(`[preFilter] total passed: ${pairs.length} → sending to Claude`)

  // ── 7. Sort + post-score filters ───────────────────────────────────────────
  pairs.sort((a, b) => sortOrder === 'asc' ? a.offer.score - b.offer.score : b.offer.score - a.offer.score)
  const filteredPairs = applyPostScoreFilters(pairs, opts?.filters)

  // ── 8. Claude evaluation ───────────────────────────────────────────────────
  let aiScoring = false
  let claudeEvaluationsCount = 0

  if (doAiScoring && filteredPairs.length === 0) {
    console.log('[match] No offers to evaluate — skipping Claude API call')
  } else if (doAiScoring) {
    const BATCH_SIZE = 100
    const totalBatches = Math.ceil(filteredPairs.length / BATCH_SIZE)
    const claudeBySlug = new Map<string, ClaudeEvaluation>()

    for (let i = 0; i < filteredPairs.length; i += BATCH_SIZE) {
      const batch = filteredPairs.slice(i, i + BATCH_SIZE)
      const batchNum = Math.floor(i / BATCH_SIZE) + 1
      console.log(`[match] Claude batch ${batchNum}/${totalBatches} (${batch.length} offers)`)
      const batchResults = await evaluateOffers(profile, batch.map(p => p.original))
      if (batchResults) {
        for (const ev of batchResults) {
          if (ev.offer_index >= 0 && ev.offer_index < batch.length) {
            claudeBySlug.set(batch[ev.offer_index].original.slug, ev)
          }
        }
      } else {
        console.warn(`[match] Claude batch ${batchNum}/${totalBatches} returned null — skipping`)
      }
    }

    if (claudeBySlug.size > 0) {
      aiScoring = true
      claudeEvaluationsCount = claudeBySlug.size

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

  // ── 9. Write user_offers ───────────────────────────────────────────────────
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

  const claudeRows = filteredPairs
    .filter(p => p.offer.recommended !== null)
    .map(p => {
      const isPendingApply = p.offer.recommended === true && p.offer.role_fit !== null
      return {
        user_id: userId,
        offer_id: p.original.id,
        status: isPendingApply ? 'pending_apply' : 'ai_rejected',
        rejection_reason: !isPendingApply ? (p.offer.role_fit ?? null) : null,
        claude_score: p.offer.score,
        claude_role_fit: p.offer.role_fit ?? null,
        claude_matched_reasons: p.offer.matched_reasons,
        claude_missing_skills: p.offer.missing_skills,
        claude_salary_comparison: p.offer.salary_comparison ?? null,
        claude_recommended: p.offer.recommended,
        matched_at: now,
        updated_at: now,
      }
    })

  const rowsToInsert = [...preFilterRows, ...claudeRows]
  const validRows = rowsToInsert.filter(r => r.offer_id != null)
  if (validRows.length !== rowsToInsert.length) {
    console.warn('[match] Skipped', rowsToInsert.length - validRows.length, 'rows with null offer_id')
  }
  if (validRows.length > 0) {
    // In-memory dedup by offer_id — safety net; preFilterRows and claudeRows are
    // disjoint by construction but this guards against any future overlap.
    const seenOfferIds = new Set<string>()
    const uniqueRows = validRows.filter(r => {
      if (seenOfferIds.has(r.offer_id)) return false
      seenOfferIds.add(r.offer_id)
      return true
    })
    if (uniqueRows.length !== validRows.length) {
      console.warn('[match] Deduplicated', validRows.length - uniqueRows.length, 'rows with duplicate offer_id')
    }
    console.log('[match] Writing to user_offers:', uniqueRows.length, 'rows for user:', userId)
    const chunkSize = 100
    let totalWritten = 0
    for (let i = 0; i < uniqueRows.length; i += chunkSize) {
      const chunk = uniqueRows.slice(i, i + chunkSize)
      const chunkResult = await prisma.userOffer.createMany({ data: chunk, skipDuplicates: true })
      totalWritten += chunkResult.count
    }
    console.log('[match] user_offers written:', totalWritten, 'rows in', Math.ceil(uniqueRows.length / chunkSize), 'chunks')
  }

  // ── 10. Stretch offers (runs after user_offers write) ─────────────────────
  const learningGoals = (profile.preferences.learning_goals ?? []).map(g => g.toLowerCase())
  const stretchOffers = await buildStretchOffers(userId, learningGoals, prisma)

  // ── 11. Log api_calls ──────────────────────────────────────────────────────
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

  const limitedMatched = filteredPairs.map(p => p.offer)
  if (limitedMatched.length > 0) {
    const first = limitedMatched[0]
    console.log('[match] First offer Claude fields — role_fit:', first.role_fit, '| recommended:', first.recommended)
  }

  return {
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
    unmatched: includeUnmatched ? unmatched : [],
    stretch_offers: stretchOffers,
  }
}

// ─── Salary helpers ───────────────────────────────────────────────────────────

export function extractAllSalaries(offer: Offer): OfferSalary[] {
  const types = parseEmploymentTypes(offer)
  return types
    .filter(t => t.from !== undefined && t.to !== undefined)
    .map(t => ({ from: t.from!, to: t.to!, currency: t.currency ?? 'PLN', type: t.type ?? 'unknown', unit: t.unit }))
}

export function extractSalary(offer: Offer): OfferSalary | null {
  const types = parseEmploymentTypes(offer)
  if (types.length === 0) return null
  for (const t of types) {
    if (t.type === 'b2b' && t.from !== undefined && t.to !== undefined) {
      return { from: t.from, to: t.to, currency: t.currency ?? 'PLN', type: 'b2b', unit: t.unit }
    }
  }
  for (const t of types) {
    if (t.from !== undefined && t.to !== undefined) {
      return { from: t.from, to: t.to, currency: t.currency ?? 'PLN', type: t.type ?? 'unknown', unit: t.unit }
    }
  }
  return null
}

// learningGoals must already be lowercased by the caller.
// Two-query approach avoids Prisma include INNER JOIN silently dropping rows
// whose related offer is inactive or deleted.
export async function buildStretchOffers(
  userId: string,
  learningGoals: string[],
  db: typeof prisma,
): Promise<StretchOffer[]> {
  if (learningGoals.length === 0) return []

  const rows = await db.userOffer.findMany({
    where: { user_id: userId, status: 'ai_rejected' },
  })

  console.log('[stretch] ai_rejected candidates:', rows.length, 'learning_goals:', learningGoals)

  const filtered = rows
    .filter(row => {
      const missing = row.claude_missing_skills.map(s => s.toLowerCase())
      if (missing.length === 0) return false
      const overlapCount = learningGoals.filter(goal => missing.includes(goal)).length
      return overlapCount / missing.length >= 0.5
    })
    .sort((a, b) => (b.claude_score ?? 0) - (a.claude_score ?? 0))

  if (filtered.length === 0) return []

  const offerIds = filtered.map(r => r.offer_id)
  const offers = await db.offer.findMany({ where: { id: { in: offerIds } } })
  const offerById = new Map(offers.map(o => [o.id, o]))

  return filtered.flatMap(row => {
    const offer = offerById.get(row.offer_id)
    if (!offer) return []
    return [{
      title: offer.title,
      company_name: offer.company_name,
      salary: extractSalary(offer),
      salaries: extractAllSalaries(offer),
      role_fit: row.claude_role_fit,
      missing_skills: row.claude_missing_skills,
      url: offer.url,
      city: offer.city ?? null,
      remote: offer.workplace_type === 'remote',
      hybrid: offer.workplace_type === 'hybrid' || offer.workplace_type === 'partly_remote',
    }]
  })
}

// ─── Private helpers ──────────────────────────────────────────────────────────

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
    salaries: extractAllSalaries(offer),
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

function applyPostScoreFilters(pairs: MatchedPair[], filters?: MatchFilters): MatchedPair[] {
  if (!filters) return pairs
  return pairs.filter(({ offer: o }) => {
    if (filters.min_score !== undefined && o.score < filters.min_score) return false
    if (filters.remote && !o.remote) return false
    if (filters.hybrid && !o.hybrid) return false
    if (filters.cities?.length) {
      const city = o.city?.toLowerCase()
      if (!city || !filters.cities.some(c => c.toLowerCase() === city)) return false
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
