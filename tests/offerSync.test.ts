import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/lib/prisma'
import { normalizeOffer } from '../src/services/offerScraper'
import type { NormalizedOffer, FetchPageResult } from '../src/services/offerScraper'

vi.mock('../src/services/offerScraper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/offerScraper')>()
  return {
    ...actual,
    fetchPage: vi.fn(),
  }
})

import { fetchPage } from '../src/services/offerScraper'
import { syncOffers } from '../src/jobs/offerSync'

const mockFetchPage = vi.mocked(fetchPage)

const TEST_SLUG_PREFIX = 'test-offersync-'

function makeOffer(slug: string, overrides: Partial<NormalizedOffer> = {}): NormalizedOffer {
  return {
    slug: `${TEST_SLUG_PREFIX}${slug}`,
    source: 'justjoin',
    title: 'Test Engineer',
    company_name: 'Test Corp',
    company_logo_url: null,
    experience_level: 'mid',
    workplace_type: 'remote',
    working_time: 'full_time',
    remote_interview: true,
    required_skills: ['typescript', 'node.js'],
    nice_to_have_skills: [],
    employment_types: [],
    multilocation: null,
    city: 'Warszawa',
    street: null,
    latitude: null,
    longitude: null,
    category_id: null,
    open_to_hire_ukrainians: null,
    languages: [],
    url: 'https://justjoin.it/test',
    published_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  }
}

// Return a single page of offers then stop
function mockSinglePage(offers: NormalizedOffer[]): void {
  mockFetchPage.mockResolvedValueOnce({ offers, nextCursor: null } satisfies FetchPageResult)
}

function makeDbOffer(slug: string) {
  return {
    slug: `${TEST_SLUG_PREFIX}${slug}`,
    source: 'justjoin',
    title: 'Test Engineer',
    company_name: 'Corp',
    required_skills: [],
    nice_to_have_skills: [],
    employment_types: [],
    languages: [],
  }
}

afterAll(async () => {
  await prisma.offer.deleteMany({ where: { slug: { startsWith: TEST_SLUG_PREFIX } } })
  await prisma.$disconnect()
})

// ─── normalizeOffer ───────────────────────────────────────────────────────────

describe('normalizeOffer', () => {
  it('extracts skill names from {name, level} objects and lowercases them', () => {
    const result = normalizeOffer({
      slug: 'test-slug',
      title: 'Dev',
      companyName: 'Corp',
      requiredSkills: [{ name: 'React', level: 3 }, { name: 'TypeScript', level: 2 }, { name: 'NODE.JS', level: 1 }],
      employmentTypes: [],
    })
    expect(result?.required_skills).toEqual(['react', 'typescript', 'node.js'])
  })

  it('returns null for a record missing slug', () => {
    expect(normalizeOffer({ title: 'Dev', companyName: 'Corp', employmentTypes: [] })).toBeNull()
  })

  it('reads top-level latitude/longitude and stores locations as multilocation', () => {
    const result = normalizeOffer({
      slug: 'test-slug',
      companyName: 'Corp',
      title: 'Dev',
      employmentTypes: [],
      street: 'Żmigrodzka 81',
      latitude: 51.14,
      longitude: 17.03,
      locations: [{ city: 'Wrocław', street: 'Żmigrodzka 81', latitude: 51.14, longitude: 17.03 }],
    })
    expect(result?.street).toBe('Żmigrodzka 81')
    expect(result?.latitude).toBe(51.14)
    expect(result?.longitude).toBe(17.03)
    expect(Array.isArray(result?.multilocation)).toBe(true)
  })

  it('defaults nice_to_have_skills to [] when null or missing', () => {
    const result = normalizeOffer({
      slug: 'test-slug',
      companyName: 'Corp',
      title: 'Dev',
      employmentTypes: [],
      niceToHaveSkills: null,
    })
    expect(result?.nice_to_have_skills).toEqual([])
  })

  it('constructs url from slug', () => {
    const result = normalizeOffer({ slug: 'company-role-city-tech', companyName: 'Corp', title: 'Dev', employmentTypes: [] })
    expect(result?.url).toBe('https://justjoin.it/job-offer/company-role-city-tech')
  })
})

// ─── syncOffers ───────────────────────────────────────────────────────────────

describe('syncOffers', () => {
  beforeEach(async () => {
    await prisma.offer.deleteMany({ where: { slug: { startsWith: TEST_SLUG_PREFIX } } })
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await prisma.offer.deleteMany({ where: { slug: { startsWith: TEST_SLUG_PREFIX } } })
  })

  it('returns early without deleting when page returns empty offers', async () => {
    await prisma.offer.create({ data: makeDbOffer('existing') })

    mockFetchPage.mockResolvedValueOnce({ offers: [], nextCursor: null })

    const result = await syncOffers()

    expect(result).toEqual({ fetched: 0, inserted: 0, updated: 0, deleted: 0 })
    expect(await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}existing` } })).not.toBeNull()
  })

  it('inserts new offers from a single page', async () => {
    mockSinglePage([makeOffer('new-1'), makeOffer('new-2')])

    const result = await syncOffers()

    expect(result.fetched).toBe(2)
    expect(result.inserted).toBe(2)
    expect(result.updated).toBe(0)
    expect(await prisma.offer.count({ where: { slug: { startsWith: TEST_SLUG_PREFIX } } })).toBe(2)
  })

  it('updates existing offers', async () => {
    await prisma.offer.create({ data: { ...makeDbOffer('existing'), title: 'Old Title' } })

    mockSinglePage([makeOffer('existing', { title: 'Updated Title' })])

    await syncOffers()

    const offer = await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}existing` } })
    expect(offer?.title).toBe('Updated Title')
  })

  it('hard deletes offers absent from all fetched pages', async () => {
    await prisma.offer.createMany({ data: [makeDbOffer('stays'), makeDbOffer('gone')] })

    mockSinglePage([makeOffer('stays')])

    await syncOffers()

    expect(await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}stays` } })).not.toBeNull()
    expect(await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}gone` } })).toBeNull()
  })

  it('upserts across multiple pages and deletes only after all pages are done', async () => {
    await prisma.offer.create({ data: makeDbOffer('old') })

    // Page 1
    mockFetchPage.mockResolvedValueOnce({ offers: [makeOffer('p1-a'), makeOffer('p1-b')], nextCursor: 100 })
    // Page 2
    mockFetchPage.mockResolvedValueOnce({ offers: [makeOffer('p2-a')], nextCursor: null })

    const result = await syncOffers()

    expect(result.fetched).toBe(3)
    expect(result.inserted).toBe(3)
    // 'old' was not in any page — should be deleted
    expect(await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}old` } })).toBeNull()
    expect(await prisma.offer.count({ where: { slug: { startsWith: TEST_SLUG_PREFIX } } })).toBe(3)
  })

  it('re-inserts an offer that was previously deleted when it reappears', async () => {
    mockSinglePage([makeOffer('comeback')])

    await syncOffers()

    expect(await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}comeback` } })).not.toBeNull()
  })
})
