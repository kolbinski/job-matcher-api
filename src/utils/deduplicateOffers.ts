import type { MatchedOffer, StretchOffer, MatchResponse } from '../types/match'

export type EtEntry = { type?: string; currency?: string; unit?: string; from?: number; to?: number }

export interface DedupableOffer {
  source: string
  title: string
  company_name: string
  experience_level: string | null
  workplace_type: string | null
  working_time: string | null
  required_skills: string[]
  nice_to_have_skills: string[]
  employment_types: unknown
  city: string | null
}

export function dedupKey(offer: DedupableOffer): string {
  const req = [...offer.required_skills].sort()
  const nth = [...offer.nice_to_have_skills].sort()
  const ets = (Array.isArray(offer.employment_types) ? (offer.employment_types as EtEntry[]) : [])
    .slice()
    .sort((a, b) => {
      if ((a.type ?? '') !== (b.type ?? '')) return (a.type ?? '') < (b.type ?? '') ? -1 : 1
      if ((a.currency ?? '') !== (b.currency ?? '')) return (a.currency ?? '') < (b.currency ?? '') ? -1 : 1
      if ((a.unit ?? '') !== (b.unit ?? '')) return (a.unit ?? '') < (b.unit ?? '') ? -1 : 1
      if ((a.from ?? 0) !== (b.from ?? 0)) return (a.from ?? 0) - (b.from ?? 0)
      return (a.to ?? 0) - (b.to ?? 0)
    })
  return JSON.stringify([
    offer.source, offer.title, offer.company_name,
    offer.experience_level, offer.workplace_type, offer.working_time,
    req, nth, ets, offer.city,
  ])
}

export interface DedupableUserOffer {
  offer: DedupableOffer
  claude_score: number | null
  matched_at: Date
}

// Collapse user_offer rows that share an offer fingerprint, keeping the row with the
// highest claude_score (tie-break: most recent matched_at). Shared by GET /v1/user-offers
// (both paths) and buildAndSaveFreePlanSnapshot.
export function dedupeUserOffers<T extends DedupableUserOffer>(rows: T[]): T[] {
  const seen = new Map<string, T>()
  for (const uo of rows) {
    const key = dedupKey(uo.offer)
    const prev = seen.get(key)
    if (!prev) {
      seen.set(key, uo)
    } else {
      const prevScore = prev.claude_score ?? -1
      const newScore = uo.claude_score ?? -1
      if (newScore > prevScore || (newScore === prevScore && uo.matched_at > prev.matched_at)) {
        seen.set(key, uo)
      }
    }
  }
  return [...seen.values()]
}

export function deduplicateMatchResult(result: MatchResponse): MatchResponse {
  const seenMatched = new Map<string, MatchedOffer>()
  for (const o of result.matched) {
    const key = dedupKey({ ...o, company_name: o.company })
    const prev = seenMatched.get(key)
    if (!prev || o.score > prev.score) seenMatched.set(key, o)
  }

  const seenStretch = new Map<string, StretchOffer>()
  for (const o of result.stretch_offers) {
    const key = dedupKey(o)
    if (!seenStretch.has(key)) seenStretch.set(key, o)
  }

  return { ...result, matched: [...seenMatched.values()], stretch_offers: [...seenStretch.values()] }
}
