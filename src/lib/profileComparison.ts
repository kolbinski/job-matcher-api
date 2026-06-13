function getField(obj: unknown, path: string[]): unknown {
  let current: unknown = obj
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const MATCHING_FIELDS: string[][] = [
  ['skills'],
  ['preferences', 'salary'],
  ['preferences', 'work_model'],
  ['preferences', 'employment_type'],
  ['preferences', 'target_role'],
  ['preferences', 'company_type_excluded'],
  ['preferences', 'markets'],
  ['red_flags'],
  ['basic_info', 'experience_level'],
  ['basic_info', 'languages'],
  ['basic_info', 'location', 'country_code'],
  ['basic_info', 'location', 'max_distance_km'],
]

// Returns true if any matching-relevant field differs between the two profiles.
export function compareMatchingFields(oldProfile: unknown, newProfile: unknown): boolean {
  return MATCHING_FIELDS.some(
    path => JSON.stringify(getField(oldProfile, path)) !== JSON.stringify(getField(newProfile, path))
  )
}
