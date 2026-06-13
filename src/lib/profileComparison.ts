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
    path => stableStringify(getField(oldProfile, path)) !== stableStringify(getField(newProfile, path))
  )
}
