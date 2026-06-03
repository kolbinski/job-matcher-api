import type { Offer } from '@prisma/client'
import type { CandidateProfile } from '../types/profile'
import { normalizeProfile } from './profileParser'

// V1-immutable weights — any change is a breaking API change (memory.md)
export const TECH_WEIGHT = 0.40
export const SALARY_WEIGHT = 0.25
export const REMOTE_WEIGHT = 0.20
export const INDUSTRY_WEIGHT = 0.15

export interface ScoredOffer {
  score: number
  techScore: number
  salaryScore: number
  remoteScore: number
  industryScore: number
  missingSkills: string[]
  matchReasons: string[]
}

interface EmploymentTypeEntry {
  type?: string
  salary?: { from?: number; to?: number; currency?: string }
}

export function scoreOffer(profile: CandidateProfile, offer: Offer): ScoredOffer {
  const norm = normalizeProfile(profile)
  const matchReasons: string[] = []

  // ── tech score ────────────────────────────────────────────────────────────
  let techScore: number
  let missingSkills: string[]

  if (offer.required_skills.length === 0) {
    techScore = 50
    missingSkills = []
  } else {
    const offerSkills = offer.required_skills.map((s) => s.toLowerCase().trim())
    const matched = offerSkills.filter((s) => norm.techs.has(s))
    missingSkills = offerSkills.filter((s) => !norm.techs.has(s))
    techScore = Math.round((matched.length / offerSkills.length) * 100)
    if (matched.length > 0) {
      matchReasons.push(`Matches ${matched.length}/${offerSkills.length} required skills (${matched.slice(0, 3).join(', ')}${matched.length > 3 ? '…' : ''})`)
    }
  }

  // ── salary score ──────────────────────────────────────────────────────────
  let salaryScore: number

  if (!norm.salaryMinPln) {
    salaryScore = 50
  } else {
    const offerMax = getBestSalary(offer)
    if (offerMax === null) {
      salaryScore = 50
    } else if (offerMax >= norm.salaryMinPln) {
      salaryScore = 100
      matchReasons.push(`Salary PLN ${offerMax.toLocaleString()} meets your target of ${norm.salaryMinPln.toLocaleString()}+`)
    } else {
      salaryScore = Math.min(99, Math.round((offerMax / norm.salaryMinPln) * 100))
    }
  }

  // ── remote score ──────────────────────────────────────────────────────────
  const remoteScore = calcRemoteScore(norm.wantsRemote, offer, matchReasons)

  // ── industry score ────────────────────────────────────────────────────────
  const industryScore = calcIndustryScore(norm.experienceLevel, offer, matchReasons)

  // ── weighted total ────────────────────────────────────────────────────────
  const score = Math.round(
    techScore * TECH_WEIGHT +
    salaryScore * SALARY_WEIGHT +
    remoteScore * REMOTE_WEIGHT +
    industryScore * INDUSTRY_WEIGHT
  )

  return { score, techScore, salaryScore, remoteScore, industryScore, missingSkills, matchReasons }
}

function getBestSalary(offer: Offer): number | null {
  const types = offer.employment_types as unknown as EmploymentTypeEntry[]
  if (!Array.isArray(types)) return null

  // Prefer B2B
  for (const t of types) {
    if (t.type === 'b2b' && t.salary?.to) return t.salary.to
  }
  // Fallback: highest to across any type
  let best: number | null = null
  for (const t of types) {
    if (t.salary?.to && t.salary.to > (best ?? 0)) best = t.salary.to
  }
  return best
}

function calcRemoteScore(
  wantsRemote: boolean,
  offer: Offer,
  matchReasons: string[]
): number {
  const workplaceType = offer.workplace_type?.toLowerCase()

  if (!wantsRemote) return 70 // neutral for in-office preference

  if (!workplaceType) return 50

  if (workplaceType === 'remote') {
    matchReasons.push('Fully remote position')
    return 100
  }
  if (workplaceType === 'hybrid' || workplaceType === 'partly_remote') return 60
  return 0 // office only
}

function calcIndustryScore(
  candidateLevel: string | null,
  offer: Offer,
  matchReasons: string[]
): number {
  const offerLevel = offer.experience_level?.toLowerCase()
  if (!offerLevel || !candidateLevel) return 75

  const LEVELS = ['junior', 'mid', 'senior', 'expert', 'c-level']
  const offerIdx = LEVELS.indexOf(offerLevel)
  const candidateIdx = LEVELS.indexOf(candidateLevel)

  if (offerIdx === -1 || candidateIdx === -1) return 75

  const diff = Math.abs(candidateIdx - offerIdx)
  if (diff === 0) {
    matchReasons.push(`${offerLevel.charAt(0).toUpperCase() + offerLevel.slice(1)}-level role matches your experience`)
    return 100
  }
  if (diff === 1) return 65
  return 30
}
