import { ApifyClient } from 'apify-client'
import { env } from '../lib/env'

// stealth_mode actor has internal pagination (offset + max_items_per_url parameters)
// and returns all listing results — not capped at 100 like RSC-payload scrapers.
// Output fields are already snake_case, matching the DB schema closely.
const ACTOR_ID = 'stealth_mode/justjoin-jobs-search-scraper'

export interface NormalizedOffer {
  slug: string
  source: string
  title: string
  company_name: string
  company_logo_url: string | null
  experience_level: string | null
  workplace_type: string | null
  working_time: string | null
  remote_interview: boolean | null
  required_skills: string[]
  nice_to_have_skills: string[]
  employment_types: unknown
  multilocation: unknown | null
  city: string | null
  street: string | null
  latitude: number | null
  longitude: number | null
  category_id: number | null
  open_to_hire_ukrainians: boolean | null
  languages: string[]
  url: string | null
  published_at: Date | null
}

function normalizeSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.toLowerCase().trim())
}

function toDate(value: unknown): Date | null {
  if (!value) return null
  const d = new Date(value as string)
  return isNaN(d.getTime()) ? null : d
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export function normalizeOffer(raw: Record<string, unknown>): NormalizedOffer | null {
  const slug = str(raw.slug)
  if (!slug) return null

  // stealth_mode uses snake_case field names and a `multilocation` array
  const loc =
    Array.isArray(raw.multilocation) && raw.multilocation.length > 0
      ? (raw.multilocation[0] as Record<string, unknown>)
      : null

  return {
    slug,
    source: 'justjoin',
    title: str(raw.title) ?? '',
    company_name: str(raw.company_name) ?? '',
    company_logo_url: str(raw.company_logo_url),
    experience_level: str(raw.experience_level),
    workplace_type: str(raw.workplace_type),
    working_time: str(raw.working_time),
    remote_interview: typeof raw.remote_interview === 'boolean' ? raw.remote_interview : null,
    required_skills: normalizeSkills(raw.required_skills),
    nice_to_have_skills: normalizeSkills(raw.nice_to_have_skills),
    employment_types: Array.isArray(raw.employment_types) ? raw.employment_types : [],
    multilocation: Array.isArray(raw.multilocation) ? raw.multilocation : null,
    city: str(raw.city),
    street: loc && typeof loc.street === 'string' ? loc.street : null,
    latitude: typeof raw.latitude === 'number' ? raw.latitude : null,
    longitude: typeof raw.longitude === 'number' ? raw.longitude : null,
    category_id: typeof raw.category_id === 'number' ? raw.category_id : null,
    open_to_hire_ukrainians:
      typeof raw.open_to_hire_ukrainians === 'boolean' ? raw.open_to_hire_ukrainians : null,
    languages: normalizeSkills(raw.languages),
    url: str(raw.job_url) ?? str(raw.url),
    published_at: toDate(raw.published_at),
  }
}

export async function fetchOffersFromApify(): Promise<NormalizedOffer[]> {
  const client = new ApifyClient({ token: env.APIFY_API_TOKEN })

  // Single all-locations URL + high max_items_per_url — the actor paginates internally
  // via its offset mechanism, unlike RSC-payload actors that are hard-capped at 100.
  const run = await client.actor(ACTOR_ID).call({
    urls: ['https://justjoin.it/job-offers/all-locations'],
    max_items_per_url: 10000,
  })

  const allItems: Record<string, unknown>[] = []
  let offset = 0
  const limit = 1000

  // Paginate through Apify dataset in chunks of 1000
  while (true) {
    const page = await client.dataset(run.defaultDatasetId).listItems({ offset, limit })
    allItems.push(...(page.items as Record<string, unknown>[]))
    if (page.items.length < limit) break
    offset += limit
  }

  const normalized: NormalizedOffer[] = []
  for (const item of allItems) {
    const offer = normalizeOffer(item)
    if (offer) normalized.push(offer)
  }

  return normalized
}
