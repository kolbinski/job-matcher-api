import type { Offer } from '@prisma/client'

// Actual field shape returned by JustJoin API and stored in employment_types JSONB.
// from/to/currency are TOP-LEVEL fields — there is NO nested salary object.
export interface EmploymentTypeEntry {
  from?: number
  to?: number
  fromPerUnit?: number
  toPerUnit?: number
  currency?: string
  type?: string
  unit?: string
  gross?: boolean
}

// Single typed entry point for reading employment_types out of Prisma's JsonValue.
export function parseEmploymentTypes(offer: Offer): EmploymentTypeEntry[] {
  const types = offer.employment_types as unknown as EmploymentTypeEntry[]
  return Array.isArray(types) ? types : []
}

// Returns the best salary ceiling (preferring contract) for score comparisons.
// Used by scoring.ts and redFlagFilter.ts.
export function getBestSalary(offer: Offer): number | null {
  const types = parseEmploymentTypes(offer)
  if (types.length === 0) return null

  for (const t of types) {
    if (t.type === 'contract' && t.to) return t.to
  }
  let best: number | null = null
  for (const t of types) {
    if (t.to && t.to > (best ?? 0)) best = t.to
  }
  return best
}
