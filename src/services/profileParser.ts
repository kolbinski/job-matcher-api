import type { CandidateProfile } from '../types/profile'

// Normalized profile view for scoring comparisons.
// Applies RULE A-3: all skill/tech names lowercased before matching.
export interface NormalizedProfile {
  techs: Set<string>
  salaryMinPln: number | null
  wantsRemote: boolean
  experienceLevel: string | null // inferred from technologies.since
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

  return { techs, salaryMinPln, wantsRemote, experienceLevel }
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
