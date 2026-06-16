interface EmploymentTypeEntry {
  from?: number | null
  to?: number | null
  currency?: string | null
  type?: string | null
  unit?: string | null
}

interface SalaryPref {
  type: string
  currency: string
  min: number
  unit?: string
}

interface SalaryResult {
  salary_min: number
  salary_max: number
  salary_currency: string
  salary_delta: number
  salary_type: string | null
}

function toMonthly(value: number, unit: string | null | undefined): number {
  switch (unit?.toLowerCase()) {
    case 'hour': return value * 168
    case 'day': return value * 21
    case 'year': return value / 12
    default: return value
  }
}

function getRate(rates: Record<string, number>, currency: string): number {
  return rates[currency.toUpperCase()] ?? 1
}

export function calculateUserOfferSalary(
  employmentTypes: unknown,
  preferredCurrency: string,
  salaryPrefs: SalaryPref[],
  exchangeRates: Record<string, number>,
): SalaryResult | null {
  if (!Array.isArray(employmentTypes) || employmentTypes.length === 0) return null

  const types = (employmentTypes as EmploymentTypeEntry[]).filter(
    t => (t.from != null && t.from > 0) || (t.to != null && t.to > 0),
  )
  if (types.length === 0) return null

  const prefCur = preferredCurrency.toUpperCase()
  const prefRate = getRate(exchangeRates, prefCur)

  function convertEntry(entry: EmploymentTypeEntry): { salaryMin: number; salaryMax: number } | null {
    if (entry.from == null || entry.to == null) return null
    const entryCur = (entry.currency ?? '').toUpperCase()
    const factor = entryCur === prefCur ? 1 : prefRate / getRate(exchangeRates, entryCur)
    return {
      salaryMin: toMonthly(entry.from, entry.unit) * factor,
      salaryMax: toMonthly(entry.to, entry.unit) * factor,
    }
  }

  function prefMinInPrefCur(pref: SalaryPref): number {
    const monthlyMin = toMonthly(pref.min, pref.unit)
    if (pref.currency.toUpperCase() === prefCur) return monthlyMin
    const prefCurrRate = getRate(exchangeRates, pref.currency)
    return monthlyMin * (prefRate / (prefCurrRate === 0 ? 1 : prefCurrRate))
  }

  // Primary: match employment_type entries against user pref types (contract/permanent)
  interface Candidate {
    entry: EmploymentTypeEntry
    salaryMin: number
    salaryMax: number
    delta: number
  }

  const candidates: Candidate[] = []
  for (const entry of types) {
    const entryType = (entry.type ?? '').toLowerCase()
    const matchingPref = salaryPrefs.find(p => p.type.toLowerCase() === entryType)
    if (!matchingPref) continue
    const converted = convertEntry(entry)
    if (!converted) continue
    const delta = converted.salaryMax - prefMinInPrefCur(matchingPref)
    candidates.push({ entry, ...converted, delta })
  }

  if (candidates.length > 0) {
    const winner = candidates.reduce((best, c) => c.delta > best.delta ? c : best)
    return {
      salary_min: Math.round(winner.salaryMin),
      salary_max: Math.round(winner.salaryMax),
      salary_currency: preferredCurrency,
      salary_delta: Math.round(winner.delta),
      salary_type: winner.entry.type ?? null,
    }
  }

  // Fallback: no type match — pick by currency priority (preferred → USD → first)
  const entry =
    types.find(t => t.currency?.toUpperCase() === prefCur) ??
    types.find(t => t.currency?.toUpperCase() === 'USD') ??
    types[0]

  if (!entry) return null
  const converted = convertEntry(entry)
  if (!converted) return null

  const entryType = (entry.type ?? '').toLowerCase()
  const pref =
    salaryPrefs.find(p => p.currency.toUpperCase() === prefCur && p.type.toLowerCase() === entryType) ??
    salaryPrefs.find(p => p.currency.toUpperCase() === prefCur) ??
    salaryPrefs[0]
  const prefMin = pref ? prefMinInPrefCur(pref) : 0

  return {
    salary_min: Math.round(converted.salaryMin),
    salary_max: Math.round(converted.salaryMax),
    salary_currency: preferredCurrency,
    salary_delta: Math.round(converted.salaryMax - prefMin),
    salary_type: entry.type ?? null,
  }
}
