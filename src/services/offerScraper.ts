const JJ_API = 'https://justjoin.it/api/candidate-api/offers'
const PAGE_SIZE = 100

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

interface RawSkill {
  name: string
  level?: number
}

function extractSkillNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((s: unknown) => {
      if (typeof s === 'string') return s.toLowerCase().trim()
      if (s && typeof (s as RawSkill).name === 'string') return (s as RawSkill).name.toLowerCase().trim()
      return null
    })
    .filter((s): s is string => s !== null && s.length > 0)
}

function toDate(value: unknown): Date | null {
  if (!value) return null
  const d = new Date(value as string)
  return isNaN(d.getTime()) ? null : d
}

export function normalizeOffer(raw: Record<string, unknown>): NormalizedOffer | null {
  const slug = typeof raw.slug === 'string' ? raw.slug : null
  if (!slug) return null

  return {
    slug,
    source: 'justjoin',
    title: typeof raw.title === 'string' ? raw.title : '',
    company_name: typeof raw.companyName === 'string' ? raw.companyName : '',
    company_logo_url: typeof raw.companyLogoThumbUrl === 'string' ? raw.companyLogoThumbUrl : null,
    experience_level: typeof raw.experienceLevel === 'string' ? raw.experienceLevel : null,
    workplace_type: typeof raw.workplaceType === 'string' ? raw.workplaceType : null,
    working_time: typeof raw.workingTime === 'string' ? raw.workingTime : null,
    remote_interview: typeof raw.isRemoteInterview === 'boolean' ? raw.isRemoteInterview : null,
    required_skills: extractSkillNames(raw.requiredSkills),
    nice_to_have_skills: extractSkillNames(raw.niceToHaveSkills),
    employment_types: Array.isArray(raw.employmentTypes) ? raw.employmentTypes : [],
    multilocation: Array.isArray(raw.locations) ? raw.locations : null,
    city: typeof raw.city === 'string' ? raw.city : null,
    street: typeof raw.street === 'string' ? raw.street : null,
    latitude: typeof raw.latitude === 'number' ? raw.latitude : null,
    longitude: typeof raw.longitude === 'number' ? raw.longitude : null,
    category_id: null, // API returns category.key (string) — not used in V1 scoring
    open_to_hire_ukrainians:
      typeof raw.isOpenToHireUkrainians === 'boolean' ? raw.isOpenToHireUkrainians : null,
    languages: extractSkillNames(raw.languages),
    url: `https://justjoin.it/job-offer/${slug}`,
    published_at: toDate(raw.publishedAt),
  }
}

interface ApiResponse {
  data: Record<string, unknown>[]
  meta: {
    next: { cursor: number | null; itemsCount: number }
  }
}

export async function fetchOffers(): Promise<NormalizedOffer[]> {
  const all: NormalizedOffer[] = []
  let from = 0

  while (true) {
    const url = `${JJ_API}?from=${from}&itemsCount=${PAGE_SIZE}`
    const res = await fetch(url)

    if (!res.ok) {
      throw new Error(`JustJoin.it API error: ${res.status} ${res.statusText} (from=${from})`)
    }

    const body = (await res.json()) as ApiResponse

    if (!Array.isArray(body.data) || body.data.length === 0) break

    for (const item of body.data) {
      const offer = normalizeOffer(item)
      if (offer) all.push(offer)
    }

    const nextCursor = body.meta?.next?.cursor
    if (nextCursor === null || nextCursor === undefined) break
    from = nextCursor
  }

  return all
}
