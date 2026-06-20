import type { MatchedOffer, StretchOffer, MatchResponse } from '../types/match'

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

export function dedupKey(offer: DedupableOffer, userWorkModel?: string[], userOfficeCities?: string[]): string {
  const req = [...offer.required_skills].sort()
  const nth = [...offer.nice_to_have_skills].sort()

  const isRemoteOnly = userWorkModel && userWorkModel.length > 0 && userWorkModel.every(m => m === 'remote')
  let city: string | null
  if (isRemoteOnly) {
    city = null
  } else if (userWorkModel && (userWorkModel.includes('hybrid') || userWorkModel.includes('office'))) {
    city = (userOfficeCities ?? []).includes(offer.city ?? '') ? offer.city : null
  } else {
    city = offer.city ?? null
  }

  return JSON.stringify([
    offer.title, offer.company_name,
    offer.experience_level, offer.workplace_type,
    req, nth, city,
  ])
}

export interface DedupableUserOffer {
  offer: DedupableOffer
  claude_score: number | null
  matched_at: Date
}

// Collapse user_offer rows that share an offer fingerprint.
// Tie-break order: preferred source → highest claude_score → most recent matched_at.
// Shared by GET /v1/user-offers (both paths) and buildAndSaveFreePlanSnapshot.
export function dedupeUserOffers<T extends DedupableUserOffer>(
  rows: T[],
  preferredSource?: string,
  userWorkModel?: string[],
  userOfficeCities?: string[],
): T[] {
  const seen = new Map<string, T>()
  for (const uo of rows) {
    const key = dedupKey(uo.offer, userWorkModel, userOfficeCities)
    const prev = seen.get(key)
    if (!prev) {
      seen.set(key, uo)
    } else {
      const curIsPreferred = preferredSource ? uo.offer.source === preferredSource : false
      const prevIsPreferred = preferredSource ? prev.offer.source === preferredSource : false
      if (curIsPreferred && !prevIsPreferred) {
        seen.set(key, uo)
      } else if (!curIsPreferred && prevIsPreferred) {
        // keep prev
      } else {
        const prevScore = prev.claude_score ?? -1
        const newScore = uo.claude_score ?? -1
        if (newScore > prevScore || (newScore === prevScore && uo.matched_at > prev.matched_at)) {
          seen.set(key, uo)
        }
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
