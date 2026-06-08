import type { MatchResponse, OfferSalary } from '../types/match'

interface OfferEntry {
  score: number
  title: string
  company: string
  work_model: 'remote' | 'hybrid' | 'office' | null
  city: string | null
  salary: OfferSalary | null
  role_fit: string | null
  url: string | null
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

function primarySalary(salaries: OfferSalary[], fallback: OfferSalary | null): OfferSalary | null {
  return salaries[0] ?? fallback ?? null
}

export function buildSyncReport(result: MatchResponse): SyncReport {
  const { matched, stretch_offers: stretch, meta } = result

  const worthApplying: OfferEntry[] = matched
    .filter(o => o.recommended === true)
    .map(o => ({
      score: o.score,
      title: o.title,
      company: o.company,
      work_model: workModel(o.remote, o.hybrid, o.city),
      city: o.city,
      salary: primarySalary(o.salaries, o.salary),
      role_fit: o.role_fit,
      url: o.url,
    }))

  const levelUp: LevelUpEntry[] = stretch.map(o => ({
    score: 0,
    title: o.title,
    company: o.company_name,
    work_model: workModel(o.remote, o.hybrid, o.city),
    city: o.city,
    salary: primarySalary(o.salaries, o.salary),
    role_fit: o.role_fit,
    url: o.url,
    skills_to_learn: o.missing_skills,
  }))

  const worthConsidering: OfferEntry[] = matched
    .filter(o => o.recommended !== true && o.score >= 30)
    .map(o => ({
      score: o.score,
      title: o.title,
      company: o.company,
      work_model: workModel(o.remote, o.hybrid, o.city),
      city: o.city,
      salary: primarySalary(o.salaries, o.salary),
      role_fit: o.role_fit,
      url: o.url,
    }))

  return {
    scanned: meta.total_offers_scanned,
    worth_applying: worthApplying,
    level_up: levelUp,
    worth_considering: worthConsidering,
  }
}
