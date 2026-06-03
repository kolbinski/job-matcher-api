import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { prisma } from '../src/lib/prisma'
import { normalizeOffer } from '../src/services/offerScraper'
import type { NormalizedOffer } from '../src/services/offerScraper'

vi.mock('../src/services/offerScraper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/offerScraper')>()
  return {
    ...actual,
    fetchOffers: vi.fn(),
  }
})

import { fetchOffers } from '../src/services/offerScraper'
import { syncOffers } from '../src/jobs/offerSync'

const mockFetch = vi.mocked(fetchOffers)

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
    employment_types: [{ from: 8000, to: 12000, currency: 'pln', type: 'b2b', unit: 'month', gross: false, fromUsd: 2000, toUsd: 3000 }],
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
    const result = normalizeOffer({ title: 'Dev', companyName: 'Corp', employmentTypes: [] })
    expect(result).toBeNull()
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
    const result = normalizeOffer({
      slug: 'company-role-city-tech',
      companyName: 'Corp',
      title: 'Dev',
      employmentTypes: [],
    })
    expect(result?.url).toBe('https://justjoin.it/job-offer/company-role-city-tech')
  })
})

// ─── syncOffers ───────────────────────────────────────────────────────────────

describe('syncOffers', () => {
  beforeEach(async () => {
    await prisma.offer.deleteMany({ where: { slug: { startsWith: TEST_SLUG_PREFIX } } })
  })

  afterEach(async () => {
    await prisma.offer.deleteMany({ where: { slug: { startsWith: TEST_SLUG_PREFIX } } })
  })

  it('returns early without deactivating anything when Apify returns empty array', async () => {
    // Seed an active offer that must NOT be deactivated
    await prisma.offer.create({
      data: {
        slug: `${TEST_SLUG_PREFIX}existing`,
        source: 'justjoin',
        title: 'Existing',
        company_name: 'Corp',
        required_skills: [],
        nice_to_have_skills: [],
        employment_types: [],
        languages: [],
        is_active: true,
      },
    })

    mockFetch.mockResolvedValueOnce([])

    const result = await syncOffers()

    expect(result).toEqual({ fetched: 0, inserted: 0, updated: 0, deactivated: 0 })

    const offer = await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}existing` } })
    expect(offer?.is_active).toBe(true)
  })

  it('inserts new offers as is_active=true', async () => {
    mockFetch.mockResolvedValueOnce([makeOffer('new-1'), makeOffer('new-2')])

    const result = await syncOffers()

    expect(result.fetched).toBe(2)
    expect(result.inserted).toBe(2)
    expect(result.updated).toBe(0)

    const offers = await prisma.offer.findMany({
      where: { slug: { startsWith: TEST_SLUG_PREFIX } },
    })
    expect(offers).toHaveLength(2)
    expect(offers.every(o => o.is_active)).toBe(true)
  })

  it('updates existing offers and keeps is_active=true', async () => {
    await prisma.offer.create({
      data: {
        slug: `${TEST_SLUG_PREFIX}existing`,
        source: 'justjoin',
        title: 'Old Title',
        company_name: 'Old Corp',
        required_skills: [],
        nice_to_have_skills: [],
        employment_types: [],
        languages: [],
        is_active: true,
      },
    })

    mockFetch.mockResolvedValueOnce([makeOffer('existing', { title: 'Updated Title' })])

    await syncOffers()

    const offer = await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}existing` } })
    expect(offer?.title).toBe('Updated Title')
    expect(offer?.is_active).toBe(true)
  })

  it('deactivates offers absent from the latest fetch', async () => {
    await prisma.offer.createMany({
      data: [
        {
          slug: `${TEST_SLUG_PREFIX}stays`,
          source: 'justjoin',
          title: 'Stays',
          company_name: 'Corp',
          required_skills: [],
          nice_to_have_skills: [],
          employment_types: [],
          languages: [],
          is_active: true,
        },
        {
          slug: `${TEST_SLUG_PREFIX}gone`,
          source: 'justjoin',
          title: 'Gone',
          company_name: 'Corp',
          required_skills: [],
          nice_to_have_skills: [],
          employment_types: [],
          languages: [],
          is_active: true,
        },
      ],
    })

    // Only `stays` appears in latest fetch; `gone` is absent
    mockFetch.mockResolvedValueOnce([makeOffer('stays')])

    await syncOffers()

    // Assert on specific offer states — not the global deactivated count,
    // which includes any real offers already in the shared DB.
    const stays = await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}stays` } })
    const gone = await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}gone` } })
    expect(stays?.is_active).toBe(true)
    expect(gone?.is_active).toBe(false)
  })

  it('reactivates a previously deactivated offer when it reappears', async () => {
    await prisma.offer.create({
      data: {
        slug: `${TEST_SLUG_PREFIX}comeback`,
        source: 'justjoin',
        title: 'Was Gone',
        company_name: 'Corp',
        required_skills: [],
        nice_to_have_skills: [],
        employment_types: [],
        languages: [],
        is_active: false,
      },
    })

    mockFetch.mockResolvedValueOnce([makeOffer('comeback')])

    await syncOffers()

    const offer = await prisma.offer.findUnique({ where: { slug: `${TEST_SLUG_PREFIX}comeback` } })
    expect(offer?.is_active).toBe(true)
  })
})
