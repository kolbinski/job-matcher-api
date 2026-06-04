import type { Offer } from '@prisma/client'
import type { NormalizedProfile } from './profileParser'
import { getBestSalary } from '../lib/offers'

// V1-immutable weights — any change is a breaking API change (memory.md)
export const TECH_WEIGHT            = 0.40
export const SALARY_WEIGHT          = 0.25
export const REMOTE_WEIGHT          = 0.20
// Note: V1 has no industry field in offer data — this weight measures seniority match.
// Rename to INDUSTRY_WEIGHT once JustJoin category-to-industry mapping is implemented.
export const EXPERIENCE_LEVEL_WEIGHT = 0.15

export interface ScoredOffer {
  score: number
  techScore: number
  salaryScore: number
  remoteScore: number
  industryScore: number
  missingSkills: string[]
  matchReasons: string[]
}

// norm is pre-computed by normalizeProfile() in the route handler — do NOT call
// normalizeProfile() here, it must be called once per request, not once per offer.
export function scoreOffer(norm: NormalizedProfile, offer: Offer): ScoredOffer {
  const matchReasons: string[] = []

  // ── tech score ────────────────────────────────────────────────────────────
  let techScore: number
  let missingSkills: string[]

  if (offer.required_skills.length === 0) {
    techScore = 50
    missingSkills = []
  } else {
    const offerSkills = offer.required_skills.map((s) => s.trim())
    const matched = offerSkills.filter((s) => norm.techs.has(s))
    missingSkills = offerSkills.filter((s) => !norm.techs.has(s))
    techScore = Math.round((matched.length / offerSkills.length) * 100)
    if (matched.length > 0) {
      matchReasons.push(
        `Matches ${matched.length}/${offerSkills.length} required skills (${matched.slice(0, 3).join(', ')}${matched.length > 3 ? '…' : ''})`
      )
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
      matchReasons.push(
        `Salary PLN ${offerMax.toLocaleString()} meets your target of ${norm.salaryMinPln.toLocaleString()}+`
      )
    } else {
      salaryScore = Math.min(99, Math.round((offerMax / norm.salaryMinPln) * 100))
    }
  }

  // ── remote score ──────────────────────────────────────────────────────────
  const remoteScore = calcRemoteScore(norm.wantsRemote, offer, matchReasons)

  // ── industry score: role category + seniority (0.15 weight) ─────────────
  const industryScore = calcIndustryScore(norm, offer, matchReasons)

  // ── weighted total ────────────────────────────────────────────────────────
  const score = Math.round(
    techScore     * TECH_WEIGHT +
    salaryScore   * SALARY_WEIGHT +
    remoteScore   * REMOTE_WEIGHT +
    industryScore * EXPERIENCE_LEVEL_WEIGHT
  )

  return { score, techScore, salaryScore, remoteScore, industryScore, missingSkills, matchReasons }
}

function calcRemoteScore(wantsRemote: boolean, offer: Offer, matchReasons: string[]): number {
  const workplaceType = offer.workplace_type?.toLowerCase()
  if (!wantsRemote) return 70
  if (!workplaceType) return 50
  if (workplaceType === 'remote') {
    matchReasons.push('Fully remote position')
    return 100
  }
  if (workplaceType === 'hybrid' || workplaceType === 'partly_remote') return 60
  return 0
}

// Infer role domain from offer title keywords.
// category_id is null in all JustJoin offers — title is the only signal.
function inferOfferCategory(offer: Offer): string | null {
  const t = offer.title.toLowerCase()
  if (/devops|site reliability|sre|platform engineer|infrastructure|network engineer|cloud engineer|systems admin|system admin/.test(t)) return 'devops'
  if (/data engineer|data scientist|machine learning|ml engineer|data analyst|bi developer|business intelligence/.test(t)) return 'data'
  if (/\bqa\b|quality assurance|test engineer|automation engineer|\btester\b/.test(t)) return 'qa'
  if (/\bios\b|\bandroid\b|mobile developer|flutter developer/.test(t)) return 'mobile'
  if (/fullstack|full[- ]stack/.test(t)) return 'fullstack'
  if (/frontend|front[- ]end/.test(t)) return 'frontend'
  if (/backend|back[- ]end/.test(t)) return 'backend'
  return null
}

const WEB_CATEGORIES = new Set(['fullstack', 'frontend', 'backend'])

function calcRoleCategoryScore(
  targetCategory: string | null,
  offerCategory: string | null,
  matchReasons: string[]
): number {
  if (!targetCategory || !offerCategory) return 75

  if (targetCategory === offerCategory) {
    matchReasons.push(`Role category match: ${offerCategory}`)
    return 100
  }

  // Crossover within web (fullstack ↔ frontend ↔ backend) — acceptable
  if (WEB_CATEGORIES.has(targetCategory) && WEB_CATEGORIES.has(offerCategory)) return 70

  // DevOps/infra offer for a web dev (or vice versa) — strong mismatch
  if (offerCategory === 'devops' && WEB_CATEGORIES.has(targetCategory)) return 10
  if (targetCategory === 'devops' && WEB_CATEGORIES.has(offerCategory)) return 10

  // Data/QA/mobile offer for web dev — moderate mismatch
  if (WEB_CATEGORIES.has(targetCategory)) return 25

  return 50
}

function calcSeniorityScore(
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
    matchReasons.push(`${offerLevel[0].toUpperCase()}${offerLevel.slice(1)}-level role matches your experience`)
    return 100
  }
  if (diff === 1) return 65
  return 30
}

// Combines role category match (60%) with seniority match (40%).
// Severe role mismatch (≤20) overrides seniority — being the right level
// for the wrong job domain is not a positive signal.
function calcIndustryScore(
  norm: NormalizedProfile,
  offer: Offer,
  matchReasons: string[]
): number {
  const offerCategory = inferOfferCategory(offer)
  const roleScore = calcRoleCategoryScore(norm.targetRoleCategory, offerCategory, matchReasons)

  if (roleScore <= 20) return roleScore

  const seniorityScore = calcSeniorityScore(norm.experienceLevel, offer, matchReasons)
  return Math.round(roleScore * 0.6 + seniorityScore * 0.4)
}
