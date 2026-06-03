import { ApifyClient } from 'apify-client'
import { env } from '../lib/env'

const ACTOR_ID = 'falconscrape/just-join-it-scraper'

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

  const loc =
    Array.isArray(raw.multilocation) && raw.multilocation.length > 0
      ? (raw.multilocation[0] as Record<string, unknown>)
      : null

  return {
    slug,
    source: 'justjoin',
    title: typeof raw.title === 'string' ? raw.title : '',
    company_name: typeof raw.companyName === 'string' ? raw.companyName : '',
    company_logo_url: typeof raw.companyLogoThumbUrl === 'string' ? raw.companyLogoThumbUrl : null,
    experience_level: typeof raw.experienceLevel === 'string' ? raw.experienceLevel : null,
    workplace_type: typeof raw.workplaceType === 'string' ? raw.workplaceType : null,
    working_time: typeof raw.workingTime === 'string' ? raw.workingTime : null,
    remote_interview: typeof raw.remoteInterview === 'boolean' ? raw.remoteInterview : null,
    required_skills: normalizeSkills(raw.requiredSkills),
    nice_to_have_skills: normalizeSkills(raw.niceToHaveSkills),
    employment_types: Array.isArray(raw.employmentTypes) ? raw.employmentTypes : [],
    multilocation: Array.isArray(raw.multilocation) ? raw.multilocation : null,
    city: typeof raw.city === 'string' ? raw.city : null,
    street: loc && typeof loc.street === 'string' ? loc.street : null,
    latitude: loc && typeof loc.latitude === 'number' ? loc.latitude : null,
    longitude: loc && typeof loc.longitude === 'number' ? loc.longitude : null,
    category_id: typeof raw.categoryId === 'number' ? raw.categoryId : null,
    open_to_hire_ukrainians:
      typeof raw.openToHireUkrainians === 'boolean' ? raw.openToHireUkrainians : null,
    languages: normalizeSkills(raw.languages),
    url: typeof raw.link === 'string' ? raw.link : null,
    published_at: toDate(raw.publishedAt),
  }
}

export async function fetchOffersFromApify(): Promise<NormalizedOffer[]> {
  const client = new ApifyClient({ token: env.APIFY_API_TOKEN })

  const run = await client.actor(ACTOR_ID).call({})

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
