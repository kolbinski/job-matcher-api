// Direct JustJoin.it API — found by stealth_mode actor network interception.
// Endpoint requires browser-like headers; Cloudflare may block plaintext server
// requests from some IP ranges. Works on Railway in practice.
const JJ_API_BASE = 'https://justjoin.it/api/candidate/api/offers'
const PAGE_SIZE = 100

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8',
  'Referer': 'https://justjoin.it/job-offers',
  'Origin': 'https://justjoin.it',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
}

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

// JustJoin.it API returns camelCase fields. Handles both the current
// /api/candidate/api/offers format and the old /api/offers format.
export function normalizeOffer(raw: Record<string, unknown>): NormalizedOffer | null {
  const slug = str(raw.slug)
  if (!slug) return null

  const loc =
    Array.isArray(raw.multilocation) && raw.multilocation.length > 0
      ? (raw.multilocation[0] as Record<string, unknown>)
      : null

  return {
    slug,
    source: 'justjoin',
    title: str(raw.title) ?? '',
    company_name: str(raw.companyName) ?? str(raw.company_name) ?? '',
    company_logo_url: str(raw.companyLogoThumbUrl) ?? str(raw.companyLogoUrl) ?? str(raw.company_logo_url),
    experience_level: str(raw.experienceLevel) ?? str(raw.experience_level),
    workplace_type: str(raw.workplaceType) ?? str(raw.workplace_type),
    working_time: str(raw.workingTime) ?? str(raw.working_time),
    remote_interview:
      typeof raw.remoteInterview === 'boolean'
        ? raw.remoteInterview
        : typeof raw.remote_interview === 'boolean'
          ? raw.remote_interview
          : null,
    required_skills: normalizeSkills(raw.requiredSkills ?? raw.required_skills),
    nice_to_have_skills: normalizeSkills(raw.niceToHaveSkills ?? raw.nice_to_have_skills),
    employment_types: Array.isArray(raw.employmentTypes)
      ? raw.employmentTypes
      : Array.isArray(raw.employment_types)
        ? raw.employment_types
        : [],
    multilocation: Array.isArray(raw.multilocation) ? raw.multilocation : null,
    city: str(raw.city),
    street: loc && typeof loc.street === 'string' ? loc.street : null,
    latitude:
      typeof raw.latitude === 'number'
        ? raw.latitude
        : loc && typeof loc.latitude === 'number'
          ? loc.latitude
          : null,
    longitude:
      typeof raw.longitude === 'number'
        ? raw.longitude
        : loc && typeof loc.longitude === 'number'
          ? loc.longitude
          : null,
    category_id:
      typeof raw.categoryId === 'number'
        ? raw.categoryId
        : typeof raw.category_id === 'number'
          ? raw.category_id
          : null,
    open_to_hire_ukrainians:
      typeof raw.openToHireUkrainians === 'boolean'
        ? raw.openToHireUkrainians
        : typeof raw.open_to_hire_ukrainians === 'boolean'
          ? raw.open_to_hire_ukrainians
          : null,
    languages: normalizeSkills(raw.languages),
    url: str(raw.link) ?? str(raw.jobUrl) ?? str(raw.job_url) ?? str(raw.url),
    published_at: toDate(raw.publishedAt ?? raw.published_at),
  }
}

export async function fetchOffers(): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = []
  let from = 0

  while (true) {
    const url = `${JJ_API_BASE}?from=${from}&itemsCount=${PAGE_SIZE}`
    const res = await fetch(url, { headers: HEADERS })

    if (!res.ok) {
      throw new Error(`JustJoin.it API error: ${res.status} ${res.statusText} at ${url}`)
    }

    const page = (await res.json()) as unknown[]

    if (!Array.isArray(page) || page.length === 0) break

    for (const item of page) {
      const offer = normalizeOffer(item as Record<string, unknown>)
      if (offer) all.push(offer)
    }

    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return all
}
