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
}

interface SalaryResult {
  salary_min: number
  salary_max: number
  salary_currency: string
  salary_delta: number
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

  const entry =
    types.find(t => t.currency?.toUpperCase() === prefCur) ??
    types.find(t => t.currency?.toUpperCase() === 'USD') ??
    types[0]

  if (!entry || entry.from == null || entry.to == null) return null

  const fromMonthly = toMonthly(entry.from, entry.unit)
  const toMonthly_ = toMonthly(entry.to, entry.unit)

  const entryRate = getRate(exchangeRates, entry.currency ?? '')
  const prefRate = getRate(exchangeRates, prefCur)
  const factor = entryRate === 0 ? 1 : prefRate / entryRate

  const salaryMin = fromMonthly * factor
  const salaryMax = toMonthly_ * factor

  const entryType = (entry.type ?? '').toLowerCase()
  const pref =
    salaryPrefs.find(
      p => p.currency.toUpperCase() === prefCur && p.type.toLowerCase() === entryType,
    ) ??
    salaryPrefs.find(p => p.currency.toUpperCase() === prefCur) ??
    salaryPrefs[0]

  let prefMin = pref?.min ?? 0
  if (pref && pref.currency.toUpperCase() !== prefCur) {
    const prefCurrRate = getRate(exchangeRates, pref.currency)
    prefMin = prefMin * (prefRate / (prefCurrRate === 0 ? 1 : prefCurrRate))
  }

  return {
    salary_min: Math.round(salaryMin),
    salary_max: Math.round(salaryMax),
    salary_currency: preferredCurrency,
    salary_delta: Math.round(salaryMax - prefMin),
  }
}
