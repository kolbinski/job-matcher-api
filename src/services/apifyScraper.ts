import { ApifyClient } from 'apify-client'
import { env } from '../lib/env'

const ACTOR_ID = 'trev0n/justjoinit-scraper'

// All JustJoin.it technology categories. Passing each as a separate startUrl gives the
// actor 24 independent entry points so it doesn't stop at the first listing page (100 offers).
// The upsert in offerSync.ts deduplicates any offer that appears in multiple categories.
const JJ_CATEGORIES = [
  'javascript', 'html', 'php', 'ruby', 'python', 'java', 'net', 'scala',
  'c', 'mobile', 'testing', 'devops', 'admin', 'ux', 'pm', 'game',
  'analytics', 'security', 'data', 'go', 'support', 'erp', 'architecture', 'ai', 'other',
]

const START_URLS = JJ_CATEGORIES.map(cat => ({
  url: `https://justjoin.it/job-offers/all-locations/${cat}`,
}))

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

export function normalizeOffer(raw: Record<string, unknown>): NormalizedOffer | null {
  const slug = typeof raw.slug === 'string' ? raw.slug : null
  if (!slug) return null

  // trev0n actor uses `locations` (not `multilocation`); no coordinates in this actor
  const loc =
    Array.isArray(raw.locations) && raw.locations.length > 0
      ? (raw.locations[0] as Record<string, unknown>)
      : null

  return {
    slug,
    source: 'justjoin',
    title: typeof raw.title === 'string' ? raw.title : '',
    company_name: typeof raw.companyName === 'string' ? raw.companyName : '',
    company_logo_url: typeof raw.companyLogoUrl === 'string' ? raw.companyLogoUrl : null,
    experience_level: typeof raw.experienceLevel === 'string' ? raw.experienceLevel : null,
    workplace_type: typeof raw.workplaceType === 'string' ? raw.workplaceType : null,
    working_time: typeof raw.workingTime === 'string' ? raw.workingTime : null,
    remote_interview: typeof raw.remoteInterview === 'boolean' ? raw.remoteInterview : null,
    required_skills: normalizeSkills(raw.requiredSkills),
    nice_to_have_skills: normalizeSkills(raw.niceToHaveSkills),
    employment_types: Array.isArray(raw.allEmploymentTypes) ? raw.allEmploymentTypes : [],
    multilocation: Array.isArray(raw.locations) ? raw.locations : null,
    city: typeof raw.city === 'string' ? raw.city : null,
    street: loc && typeof loc.street === 'string' ? loc.street : null,
    latitude: null,
    longitude: null,
    category_id: typeof raw.categoryId === 'number' ? raw.categoryId : null,
    open_to_hire_ukrainians: null,
    languages: normalizeSkills(raw.languages),
    url: typeof raw.jobUrl === 'string' ? raw.jobUrl : null,
    published_at: toDate(raw.publishedAt),
  }
}

export async function fetchOffersFromApify(): Promise<NormalizedOffer[]> {
  const client = new ApifyClient({ token: env.APIFY_API_TOKEN })

  // startUrls: one entry per category so the actor has 24 independent starting points.
  // Without this, the actor hits the default listing once and stops at 100 offers.
  // maxItems: 0 = unlimited within each startUrl.
  const run = await client.actor(ACTOR_ID).call({ startUrls: START_URLS, maxItems: 0 })

  const allItems: Record<string, unknown>[] = []
  let offset = 0
  const limit = 1000

  // Paginate through dataset — listItems defaults to 1000 items per page
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
