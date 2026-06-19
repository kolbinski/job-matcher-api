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
  const key = JSON.stringify([
    offer.source, offer.title, offer.company_name,
    offer.experience_level, offer.workplace_type, offer.working_time,
    req, nth, ets, offer.city,
  ])
  if (offer.title === 'Senior Frontend Developer' && offer.company_name?.toLowerCase() === 'scalo') {
    console.log('[dedup] key for', offer.city, JSON.stringify(offer.employment_types), '→', key);
  }
  return key
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
