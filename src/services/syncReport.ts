import type { MatchResponse, MatchedOffer, StretchOffer, OfferSalary } from '../types/match'

export interface SalaryPref {
  type: string
  currency: string
  min: number
}

interface SalaryEntry {
  min: number
  max: number
  currency: string
  type: string
  delta: number
  delta_normalized: number
}

interface OfferEntry {
  score: number
  title: string
  company: string
  work_model: 'remote' | 'hybrid' | 'office' | null
  city: string | null
  salary: SalaryEntry[]
  role_fit: string | null
  url: string | null
  source: string
}

interface LevelUpEntry extends OfferEntry {
  skills_to_learn: string[]
}

export interface SyncReport {
  scanned: number
  worth_applying: OfferEntry[]
  level_up: LevelUpEntry[]
  worth_considering: OfferEntry[]
}

function workModel(remote: boolean, hybrid: boolean, city: string | null): 'remote' | 'hybrid' | 'office' | null {
  if (remote) return 'remote'
  if (hybrid) return 'hybrid'
  if (city) return 'office'
  return null
}

function computeSalaryEntries(
  salaries: OfferSalary[],
  prefs: SalaryPref[],
  rates: Record<string, number>,
): SalaryEntry[] {
  if (prefs.length === 0) return []
  const entries: SalaryEntry[] = []
  for (const s of salaries) {
    const pref = prefs.find(
      p => p.type.toLowerCase() === s.type.toLowerCase() &&
           p.currency.toUpperCase() === s.currency.toUpperCase()
    )
    if (!pref) continue
    const effectiveTo = s.unit?.toLowerCase() === 'day' ? s.to * 20 : s.to
    const delta = effectiveTo - pref.min
    const rate = s.currency.toUpperCase() === 'PLN' ? 1 : (rates[s.currency.toUpperCase()] ?? 1)
    entries.push({
      min: s.from,
      max: s.to,
      currency: s.currency,
      type: s.type,
      delta,
      delta_normalized: Math.round(delta * rate),
    })
  }
  return entries
}

function salariesFor(salaries: OfferSalary[], fallback: OfferSalary | null): OfferSalary[] {
  return salaries.length > 0 ? salaries : (fallback ? [fallback] : [])
}

function matchedToEntry(o: MatchedOffer, prefs: SalaryPref[], rates: Record<string, number>): OfferEntry {
  return {
    score: o.score,
    title: o.title,
    company: o.company,
    work_model: workModel(o.remote, o.hybrid, o.city),
    city: o.city,
    salary: computeSalaryEntries(salariesFor(o.salaries, o.salary), prefs, rates),
    role_fit: o.role_fit,
    url: o.url,
    source: o.source,
  }
}

function stretchToEntry(o: StretchOffer, prefs: SalaryPref[], rates: Record<string, number>): LevelUpEntry {
  return {
    score: 0,
    title: o.title,
    company: o.company_name,
    work_model: workModel(o.remote, o.hybrid, o.city),
    city: o.city,
    salary: computeSalaryEntries(salariesFor(o.salaries, o.salary), prefs, rates),
    role_fit: o.role_fit,
    url: o.url,
    skills_to_learn: o.missing_skills,
    source: o.source,
  }
}

export function buildSyncReport(
  result: MatchResponse,
  salaryPrefs: SalaryPref[],
  rates: Record<string, number>,
  maxLevelUp = 40,
): SyncReport {
  const { matched, stretch_offers: stretch, meta } = result
  return {
    scanned: meta.total_offers_scanned,
    worth_applying: matched
      .filter(o => o.recommended === true)
      .map(o => matchedToEntry(o, salaryPrefs, rates)),
    level_up: stretch.slice(0, maxLevelUp).map(o => stretchToEntry(o, salaryPrefs, rates)),
    worth_considering: matched
      .filter(o => o.recommended !== true && o.score >= 30)
      .map(o => matchedToEntry(o, salaryPrefs, rates)),
  }
}
