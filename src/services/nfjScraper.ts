import type { EmploymentTypeEntry } from '../lib/offers'
import type { NormalizedOffer } from './offerScraper'

const NFJ_API = 'https://nofluffjobs.com/api/joboffers/main'
const NFJ_PAGE_SIZE = 20

const NFJ_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://nofluffjobs.com/pl',
  'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'application/json, text/plain, */*',
}

function mapSeniority(raw: string): string {
  const lower = raw.toLowerCase()
  return lower === 'expert' ? 'c_level' : lower
}

interface NfjPlace {
  city?: string
  country?: { code: string; name: string }
  geoLocation?: { latitude: number; longitude: number }
  provinceOnly?: boolean
}

interface NfjLocation {
  places: NfjPlace[]
  fullyRemote: boolean
  hybridDesc: string
}

interface NfjSalary {
  from: number
  to: number
  type: string
  currency: string
}

interface NfjPosting {
  id: string
  name: string
  location: NfjLocation
  posted: number
  title: string
  url: string
  salary: NfjSalary | null
  seniority: string[]
  tiles: { values: Array<{ value: string; type: string }> }
  help4Ua: boolean
}

interface NfjApiResponse {
  postings: NfjPosting[]
}

export function normalizeNfjOffer(raw: NfjPosting): NormalizedOffer | null {
  if (!raw.id || !raw.title) return null

  const loc = raw.location ?? { places: [], fullyRemote: false, hybridDesc: '' }

  let workplaceType: string
  if (loc.fullyRemote) {
    workplaceType = 'remote'
  } else if (loc.hybridDesc) {
    workplaceType = 'hybrid'
  } else {
    workplaceType = 'office'
  }

  const experienceLevel = raw.seniority?.[0] ? mapSeniority(raw.seniority[0]) : null

  const requiredSkills = (raw.tiles?.values ?? [])
    .filter(t => t.type === 'requirement')
    .map(t => t.value.toLowerCase().trim())
    .filter(v => v.length > 0)

  const employmentTypes: EmploymentTypeEntry[] = raw.salary
    ? [{ type: raw.salary.type, from: raw.salary.from, to: raw.salary.to, currency: raw.salary.currency, unit: 'Month' }]
    : []

  const realPlace = loc.places.find(p => p.city && p.country && !p.provinceOnly) ?? null

  return {
    slug: `nfj-${raw.id}`,
    source: 'nofluffjobs',
    title: raw.title,
    company_name: raw.name ?? '',
    company_logo_url: null,
    experience_level: experienceLevel,
    workplace_type: workplaceType,
    working_time: null,
    remote_interview: null,
    required_skills: requiredSkills,
    nice_to_have_skills: [],
    employment_types: employmentTypes,
    multilocation: null,
    city: realPlace?.city ?? null,
    street: null,
    latitude: realPlace?.geoLocation?.latitude ?? null,
    longitude: realPlace?.geoLocation?.longitude ?? null,
    open_to_hire_ukrainians: typeof raw.help4Ua === 'boolean' ? raw.help4Ua : null,
    languages: [],
    url: raw.url ? `https://nofluffjobs.com/job/${raw.url}` : null,
    published_at: raw.posted ? new Date(raw.posted) : null,
  }
}

export async function fetchNfjPage(pageNum: number): Promise<{ offers: NormalizedOffer[] }> {
  const params = new URLSearchParams({
    pageTo: String(pageNum),
    pageSize: String(NFJ_PAGE_SIZE),
    withSalaryMatch: 'true',
    salaryCurrency: 'PLN',
    salaryPeriod: 'month',
    region: 'pl',
    language: 'pl-PL',
  })

  const res = await fetch(`${NFJ_API}?${params}`, { headers: NFJ_HEADERS })

  if (!res.ok) {
    throw new Error(`[offerScraper][nofluffjobs] API error: ${res.status} ${res.statusText} (page=${pageNum})`)
  }

  const body = (await res.json()) as NfjApiResponse

  if (!Array.isArray(body.postings) || body.postings.length === 0) {
    return { offers: [] }
  }

  const offers: NormalizedOffer[] = []
  for (const posting of body.postings) {
    const offer = normalizeNfjOffer(posting)
    if (offer) offers.push(offer)
  }

  return { offers }
}
