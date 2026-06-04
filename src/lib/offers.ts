import type { Offer } from '@prisma/client'

// Actual field shape returned by JustJoin API and stored in employment_types JSONB.
// from/to/currency are TOP-LEVEL fields — there is NO nested salary object.
export interface EmploymentTypeEntry {
  from?: number
  to?: number
  currency?: string
  type?: string
  unit?: string
  gross?: boolean
}

// Returns the best salary ceiling (preferring B2B) for score comparisons.
// Used by scoring.ts and redFlagFilter.ts.
export function getBestSalary(offer: Offer): number | null {
  const types = offer.employment_types as unknown as EmploymentTypeEntry[]
  if (!Array.isArray(types)) return null

  for (const t of types) {
    if (t.type === 'b2b' && t.to) return t.to
  }
  let best: number | null = null
  for (const t of types) {
    if (t.to && t.to > (best ?? 0)) best = t.to
  }
  return best
}
