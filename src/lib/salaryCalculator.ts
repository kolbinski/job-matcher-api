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

interface SalaryRange {
  min: number
  max: number
  delta: number
}

interface SalaryResult {
  contract?: SalaryRange
  permanent?: SalaryRange
  salary_currency: string
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
    const salaryMin = toMonthly(entry.from, entry.unit)
    const salaryMax = toMonthly(entry.to, entry.unit)
    const entryCur = (entry.currency ?? '').toUpperCase()
if (entryCur === prefCur) return { salaryMin, salaryMax }
    const entryRate = getRate(exchangeRates, entryCur)
    return {
      salaryMin: salaryMin * (prefRate / entryRate),
      salaryMax: salaryMax * (prefRate / entryRate),
    }
  }

  function prefMinInPrefCur(pref: SalaryPref): number {
    const monthlyMin = toMonthly(pref.min, pref.unit)
    if (pref.currency.toUpperCase() === prefCur) return monthlyMin
    const prefCurrRate = getRate(exchangeRates, pref.currency)
    return monthlyMin * (prefRate / (prefCurrRate === 0 ? 1 : prefCurrRate))
  }

  // Build a range for a given pref type (contract/permanent) from matching
  // employment_type entries: convert to monthly + preferred currency, then compute
  // delta vs the matching salary pref. Prefer an entry already in the preferred
  // currency, else the one with the highest converted max.
  function buildRange(targetType: 'contract' | 'permanent'): SalaryRange | undefined {
    const converted = types
      .filter(t => (t.type ?? '').toLowerCase() === targetType)
      .map(e => ({ entry: e, c: convertEntry(e) }))
      .filter((x): x is { entry: EmploymentTypeEntry; c: { salaryMin: number; salaryMax: number } } => x.c !== null)
    if (converted.length === 0) return undefined

    const winner =
      converted.find(x => (x.entry.currency ?? '').toUpperCase() === prefCur) ??
      converted.reduce((best, x) => (x.c.salaryMax > best.c.salaryMax ? x : best))

    const pref =
      salaryPrefs.find(p => p.type.toLowerCase() === targetType && p.currency.toUpperCase() === prefCur) ??
      salaryPrefs.find(p => p.type.toLowerCase() === targetType) ??
      salaryPrefs.find(p => p.currency.toUpperCase() === prefCur) ??
      salaryPrefs[0]
    const prefMin = pref ? prefMinInPrefCur(pref) : 0

    return {
      min: Math.round(winner.c.salaryMin),
      max: Math.round(winner.c.salaryMax),
      delta: Math.round(winner.c.salaryMax - prefMin),
    }
  }

  const contract = buildRange('contract')
  const permanent = buildRange('permanent')
  if (!contract && !permanent) return null

  return {
    ...(contract ? { contract } : {}),
    ...(permanent ? { permanent } : {}),
    salary_currency: preferredCurrency,
  }
}
