import type { CandidateProfile } from '../types/profile'

// Normalized profile view for scoring comparisons.
// Applies RULE A-3: all skill/tech names lowercased before matching.
export interface NormalizedProfile {
  techs: Set<string>
  salaryMinPln: number | null
  wantsRemote: boolean
  experienceLevel: string | null // inferred from technologies.since
  targetRoleCategory: string | null // inferred from career_goals.short_term.target_role
  maxOfficeDays: number | null
  candidateLocation: { lat: number; lon: number; maxDistanceKm: number } | null
  rejectedTechs: Set<string>
}

export function normalizeProfile(profile: CandidateProfile): NormalizedProfile {
  const techs = new Set(
    profile.technologies.map((t) => t.name.toLowerCase().trim())
  )

  const salaryMinPln =
    profile.preferences?.salary_pln_net_b2b?.min ??
    profile.career_goals?.short_term?.salary_target_pln_net_b2b?.min ??
    null

  const wantsRemote =
    profile.basic_info.remote_ok ||
    profile.preferences?.work_model?.toLowerCase() === 'remote'

  const experienceLevel = inferExperienceLevel(profile)

  const targetRoleCategory = inferCandidateCategory(
    profile.career_goals?.short_term?.target_role?.[0] ?? null
  )

  const maxOfficeDays = profile.preferences?.max_office_days_per_week ?? null

  const loc = profile.basic_info.location
  const candidateLocation =
    loc &&
    typeof loc.latitude === 'number' &&
    typeof loc.longitude === 'number' &&
    typeof loc.max_distance_km === 'number'
      ? { lat: loc.latitude, lon: loc.longitude, maxDistanceKm: loc.max_distance_km }
      : null

  const rejectedTechs = new Set(
    profile.red_flags
      .filter((f) => ['technology', 'tech', 'stack', 'technologies'].includes(f.category.toLowerCase()))
      .flatMap((f) =>
        f.description
          .split(/[,;]/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      )
  )

  return { techs, salaryMinPln, wantsRemote, experienceLevel, targetRoleCategory, maxOfficeDays, candidateLocation, rejectedTechs }
}

export function inferCandidateCategory(targetRole: string | null): string | null {
  if (!targetRole) return null
  const r = targetRole.toLowerCase()
  if (/fullstack|full[- ]stack/.test(r)) return 'fullstack'
  if (/frontend|front[- ]end/.test(r)) return 'frontend'
  if (/backend|back[- ]end/.test(r)) return 'backend'
  if (/devops|sre|platform|infrastructure/.test(r)) return 'devops'
  if (/data|machine learning|ml engineer/.test(r)) return 'data'
  if (/mobile|ios|android/.test(r)) return 'mobile'
  if (/\bqa\b|quality assurance|test/.test(r)) return 'qa'
  return null
}

function inferExperienceLevel(profile: CandidateProfile): string | null {
  const years = profile.technologies
    .map((t) => t.since)
    .filter((y): y is number => typeof y === 'number' && y > 1990)

  if (years.length === 0) return null

  const yearsExp = new Date().getFullYear() - Math.min(...years)
  if (yearsExp >= 7) return 'senior'
  if (yearsExp >= 3) return 'mid'
  return 'junior'
}
