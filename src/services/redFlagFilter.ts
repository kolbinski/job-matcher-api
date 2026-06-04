import type { Offer } from '@prisma/client'
import type { CandidateProfile } from '../types/profile'
import { parseEmploymentTypes } from '../lib/offers'

export interface PreFilterResult {
  pass: boolean
  reasons: string[]
  rejectedByWorkplace: boolean
  rejectedByEmploymentType: boolean
  rejectedBySalary: boolean
  rejectedBySeniority: boolean
  rejectedByRedFlags: boolean
}

// Ordered seniority levels — used for ±1 tolerance check.
// Values come from JustJoin offer data; c_level normalised to c-level.
const LEVELS = ['junior', 'mid', 'senior', 'expert', 'c-level']

function normalizeLevel(level: string): string {
  return level.replace('_', '-').toLowerCase()
}

export function applyPreFilters(profile: CandidateProfile, offer: Offer): PreFilterResult {
  const reasons: string[] = []
  let rejectedByWorkplace = false
  let rejectedByEmploymentType = false
  let rejectedBySalary = false
  let rejectedBySeniority = false
  let rejectedByRedFlags = false

  // ── 1. Workplace filter ────────────────────────────────────────────────────
  const acceptedModels = (profile.preferences?.work_model ?? []).map(m => m.toLowerCase())
  if (acceptedModels.length > 0) {
    const raw = offer.workplace_type?.toLowerCase() ?? null
    // partly_remote is treated as hybrid for matching
    const offerModel = raw === 'partly_remote' ? 'hybrid' : raw
    if (offerModel && !acceptedModels.includes(offerModel)) {
      reasons.push(`Offer requires ${offerModel} work but candidate only accepts ${acceptedModels.join('/')}`)
      rejectedByWorkplace = true
    }
  }

  // ── 2. Employment type filter ──────────────────────────────────────────────
  const acceptedTypes = (profile.preferences?.employment_type ?? []).map(t => t.toLowerCase())
  if (acceptedTypes.length > 0) {
    const offerTypes = [...new Set(
      parseEmploymentTypes(offer)
        .map(e => e.type?.toLowerCase())
        .filter((t): t is string => Boolean(t))
    )]
    // "any" means employer accepts all contract forms — never reject
    const hasAny = offerTypes.includes('any')
    // Only reject if offer has declared types, none match, and none is "any"
    if (!hasAny && offerTypes.length > 0 && !acceptedTypes.some(t => offerTypes.includes(t))) {
      reasons.push(`Offer only provides ${offerTypes.join(', ')} contract but candidate wants ${acceptedTypes.join('/')}`)
      rejectedByEmploymentType = true
    }
  }

  // ── 3. Salary filter ───────────────────────────────────────────────────────
  const salaryPrefs = profile.preferences?.salary ?? []
  if (salaryPrefs.length > 0) {
    const entries = parseEmploymentTypes(offer)
    for (const pref of salaryPrefs) {
      const matching = entries.filter(
        e =>
          e.type?.toLowerCase() === pref.type.toLowerCase() &&
          e.currency?.toUpperCase() === pref.currency.toUpperCase()
      )
      if (matching.length === 0) continue // not disclosed for this type → don't reject

      const monthlyMaxes = matching
        .map(e => {
          if (e.to === undefined) return null
          return e.unit?.toLowerCase() === 'day' ? e.to * 20 : e.to
        })
        .filter((v): v is number => v !== null)

      if (monthlyMaxes.length === 0) continue // no ceiling disclosed → don't reject

      const bestMax = Math.max(...monthlyMaxes)
      if (bestMax < pref.min) {
        reasons.push(
          `Best ${pref.type} salary ${bestMax.toLocaleString()} ${pref.currency} is below candidate's minimum of ${pref.min.toLocaleString()} ${pref.currency}`
        )
        rejectedBySalary = true
      }
    }
  }

  // ── 4. Seniority filter ────────────────────────────────────────────────────
  const candidateLevelRaw = profile.basic_info.experience_level
  if (candidateLevelRaw) {
    const candidateLevel = normalizeLevel(candidateLevelRaw)
    const offerLevel = offer.experience_level?.toLowerCase()
    if (offerLevel) {
      const ci = LEVELS.indexOf(candidateLevel)
      const oi = LEVELS.indexOf(offerLevel)
      if (ci !== -1 && oi !== -1 && Math.abs(ci - oi) > 1) {
        reasons.push(`Offer is for ${offerLevel} level but candidate is ${candidateLevel}`)
        rejectedBySeniority = true
      }
    }
  }

  // ── 5. Technology red flags ────────────────────────────────────────────────
  for (const flag of profile.red_flags) {
    const category = flag.category.toLowerCase()
    const desc = flag.description.toLowerCase()

    if (['technology', 'tech', 'stack', 'technologies'].includes(category)) {
      const forbidden = desc.split(/[,;]/).map(t => t.trim().toLowerCase()).filter(Boolean)
      const offerTechs = offer.required_skills.map(s => s.toLowerCase())
      for (const tech of forbidden) {
        const pattern = new RegExp(
          `(^|[^a-z0-9])${tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`
        )
        if (offerTechs.some(o => o === tech || pattern.test(o))) {
          reasons.push(`Offer requires ${tech} which is on candidate's rejected technologies list`)
          rejectedByRedFlags = true
          break
        }
      }
    }
  }

  return {
    pass: reasons.length === 0,
    reasons,
    rejectedByWorkplace,
    rejectedByEmploymentType,
    rejectedBySalary,
    rejectedBySeniority,
    rejectedByRedFlags,
  }
}

// Kept for backward compatibility with existing tests.
export function filterRedFlags(profile: CandidateProfile, offer: Offer): string[] {
  // Only returns tech red flag reasons — structured filters are now in applyPreFilters.
  const reasons: string[] = []
  for (const flag of profile.red_flags) {
    const category = flag.category.toLowerCase()
    const desc = flag.description.toLowerCase()
    if (['technology', 'tech', 'stack', 'technologies'].includes(category)) {
      const forbidden = desc.split(/[,;]/).map(t => t.trim().toLowerCase()).filter(Boolean)
      const offerTechs = offer.required_skills.map(s => s.toLowerCase())
      for (const tech of forbidden) {
        const pattern = new RegExp(
          `(^|[^a-z0-9])${tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`
        )
        if (offerTechs.some(o => o === tech || pattern.test(o))) {
          reasons.push(`Offer requires ${tech} which is on candidate's rejected technologies list`)
          break
        }
      }
    }
  }
  return reasons
}
