function getField(obj: unknown, path: string[]): unknown {
  let current: unknown = obj
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function stableStringify(val: unknown): string {
  if (Array.isArray(val)) {
    return '[' + val.map(stableStringify).sort().join(',') + ']'
  }
  if (val !== null && typeof val === 'object') {
    const sorted = Object.keys(val as object).sort().reduce((acc, k) => {
      acc[k] = (val as Record<string, unknown>)[k]
      return acc
    }, {} as Record<string, unknown>)
    return JSON.stringify(sorted, (_, v) =>
      Array.isArray(v) ? v.map(stableStringify).sort() : v
    )
  }
  return JSON.stringify(val)
}

const MATCHING_FIELDS: string[][] = [
  ['skills'],
  ['preferences', 'salary'],
  ['preferences', 'work_model'],
  ['preferences', 'target_role'],
  ['preferences', 'company_type_excluded'],
  ['preferences', 'markets'],
  ['preferences', 'learning_skills_goals'],
  ['red_flags'],
  ['basic_info', 'experience_level'],
  ['basic_info', 'languages'],
  ['basic_info', 'location', 'country_code'],
  ['basic_info', 'location', 'max_distance_km'],
]

type WorkExp = { title?: unknown; projects?: Array<{ skills?: unknown[] }> }
type OwnProject = { skills?: unknown[] }
type Certification = { name?: unknown }

function extractWorkExpProjectSkills(profile: unknown): string {
  const exps = (getField(profile, ['work_experience']) as WorkExp[] | null | undefined) ?? []
  const skills = exps.flatMap(exp => (exp.projects ?? []).flatMap(p => p.skills ?? []))
  return stableStringify(skills)
}

function extractWorkExpTitles(profile: unknown): string {
  const exps = (getField(profile, ['work_experience']) as WorkExp[] | null | undefined) ?? []
  return stableStringify(exps.map(exp => exp.title))
}

function extractCertificationNames(profile: unknown): string {
  const certs = (getField(profile, ['certifications']) as Certification[] | null | undefined) ?? []
  return stableStringify(certs.map(c => c.name))
}

function extractOwnProjectSkills(profile: unknown): string {
  const projects = (getField(profile, ['own_projects']) as OwnProject[] | null | undefined) ?? []
  return stableStringify(projects.flatMap(p => p.skills ?? []))
}

function extractSalaryPrefUnits(profile: unknown): string {
  const salary = (getField(profile, ['preferences', 'salary']) as Array<{ unit?: unknown }> | null | undefined) ?? []
  return stableStringify(salary.map(s => s.unit ?? null))
}

// Returns true if any matching-relevant field differs between the two profiles.
// Returns false if oldProfile is null (no snapshot — treat as no change).
export function compareMatchingFields(oldProfile: unknown, newProfile: unknown): boolean {
  if (oldProfile == null) return false

  const pathChanged = MATCHING_FIELDS.some(
    path => stableStringify(getField(oldProfile, path)) !== stableStringify(getField(newProfile, path))
  )
  if (pathChanged) return true

  return (
    extractWorkExpProjectSkills(oldProfile) !== extractWorkExpProjectSkills(newProfile) ||
    extractWorkExpTitles(oldProfile) !== extractWorkExpTitles(newProfile) ||
    extractCertificationNames(oldProfile) !== extractCertificationNames(newProfile) ||
    extractOwnProjectSkills(oldProfile) !== extractOwnProjectSkills(newProfile) ||
    extractSalaryPrefUnits(oldProfile) !== extractSalaryPrefUnits(newProfile)
  )
}
