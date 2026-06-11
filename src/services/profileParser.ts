import type { CandidateProfile } from '../types/profile'

export interface NormalizedProfile {
  techs: Set<string>
  salaryMinPln: number | null      // first contract PLN salary min, used by scoring
  workModel: string[]              // accepted workplace types, lowercase
  experienceLevel: string | null   // from basic_info.experience_level, c_level → c-level
  maxOfficeDays: number | null
  candidateLocation: { lat: number; lon: number; maxDistanceKm: number } | null
  rejectedTechs: Set<string>
}

export function normalizeProfile(profile: CandidateProfile): NormalizedProfile {
  const techs = new Set(
    Object.values(profile.skills).flat().map(t => t.name.toLowerCase().trim())
  )

  const salaryMinPln =
    profile.preferences?.salary?.find(
      s => s.type === 'contract' && s.currency.toUpperCase() === 'PLN'
    )?.min ??
    null

  const workModel = (profile.preferences?.work_model ?? []).map(m => m.toLowerCase())

  const experienceLevel = profile.basic_info.experience_level
    ? profile.basic_info.experience_level.replace('_', '-').toLowerCase()
    : null

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
      .filter(f => ['technology', 'tech', 'stack', 'technologies', 'skills'].includes(f.category.toLowerCase()))
      .flatMap(f =>
        Array.isArray(f.description)
          ? f.description.map(t => t.trim().toLowerCase()).filter(Boolean)
          : f.description.split(/[,;]/).map(t => t.trim().toLowerCase()).filter(Boolean)
      )
  )

  return { techs, salaryMinPln, workModel, experienceLevel, maxOfficeDays, candidateLocation, rejectedTechs }
}

