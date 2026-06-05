import { describe, it, expect } from 'vitest'
import type { Offer } from '@prisma/client'
import { buildStretchOffers } from '../src/routes/match'
import type { MatchedPair } from '../src/routes/match'
import type { MatchedOffer } from '../src/types/match'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'test-id',
    slug: 'test-slug',
    is_active: true,
    source: 'justjoin',
    title: 'Software Engineer',
    company_name: 'Acme Corp',
    company_logo_url: null,
    experience_level: 'senior',
    workplace_type: 'remote',
    working_time: null,
    remote_interview: null,
    required_skills: [],
    nice_to_have_skills: [],
    employment_types: [],
    multilocation: null,
    city: 'Warsaw',
    street: null,
    latitude: null,
    longitude: null,
    category_id: null,
    open_to_hire_ukrainians: null,
    languages: [],
    url: 'https://example.com/job/1',
    published_at: null,
    fetched_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeMatchedOffer(overrides: Partial<MatchedOffer> = {}): MatchedOffer {
  return {
    score: 50,
    title: 'Software Engineer',
    company: 'Acme Corp',
    city: 'Warsaw',
    remote: true,
    hybrid: false,
    experience_level: 'senior',
    salary: null,
    matched_reasons: [],
    missing_skills: [],
    red_flags_found: [],
    rank: null,
    salary_comparison: null,
    role_fit: null,
    recommended: null,
    url: 'https://example.com/job/1',
    source: 'justjoin',
    fetched_at: null,
    ...overrides,
  }
}

function makePair(offerOverrides: Partial<Offer> = {}, matchedOverrides: Partial<MatchedOffer> = {}): MatchedPair {
  return {
    original: makeOffer(offerOverrides),
    offer: makeMatchedOffer(matchedOverrides),
  }
}

// B2B employment_types with a known salary ceiling
function b2bTypes(to: number, currency = 'PLN') {
  return [{ type: 'b2b', from: to - 2000, to, currency }]
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('buildStretchOffers', () => {
  it('returns empty array when learning_goals is empty', () => {
    const pair = makePair({}, { recommended: false, missing_skills: ['python'] })
    expect(buildStretchOffers([pair], [])).toEqual([])
  })

  it('returns empty array when no pairs are ai_rejected', () => {
    const pair = makePair({}, { recommended: true, missing_skills: ['python'] })
    expect(buildStretchOffers([pair], ['python'])).toEqual([])
  })

  it('returns empty array when recommended is null (not evaluated by Claude)', () => {
    const pair = makePair({}, { recommended: null, missing_skills: ['python'] })
    expect(buildStretchOffers([pair], ['python'])).toEqual([])
  })

  it('returns empty array when ai_rejected offer has no overlapping missing_skills', () => {
    const pair = makePair({}, { recommended: false, missing_skills: ['java', 'spring'] })
    expect(buildStretchOffers([pair], ['python', 'terraform'])).toEqual([])
  })

  it('returns a stretch offer when missing_skills overlaps with learning_goals', () => {
    const pair = makePair(
      { title: 'DevOps Engineer', company_name: 'CloudCo', url: 'https://example.com/1' },
      { recommended: false, missing_skills: ['terraform', 'ansible'], role_fit: 'Missing IaC experience' },
    )
    const result = buildStretchOffers([pair], ['terraform'])
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('DevOps Engineer')
    expect(result[0].company_name).toBe('CloudCo')
    expect(result[0].missing_skills).toEqual(['terraform', 'ansible'])
    expect(result[0].role_fit).toBe('Missing IaC experience')
    expect(result[0].url).toBe('https://example.com/1')
  })

  it('matching is case-insensitive — "Python" in missing_skills matches "python" in goals', () => {
    const pair = makePair(
      { employment_types: b2bTypes(20000) },
      { recommended: false, missing_skills: ['Python', 'Django'] },
    )
    const result = buildStretchOffers([pair], ['python'])
    expect(result).toHaveLength(1)
  })

  it('sorts by salary descending (highest .to first)', () => {
    const low  = makePair({ id: 'low',  slug: 'low',  employment_types: b2bTypes(15000) }, { recommended: false, missing_skills: ['python'] })
    const high = makePair({ id: 'high', slug: 'high', employment_types: b2bTypes(30000) }, { recommended: false, missing_skills: ['terraform'] })
    const mid  = makePair({ id: 'mid',  slug: 'mid',  employment_types: b2bTypes(22000) }, { recommended: false, missing_skills: ['python', 'terraform'] })

    const result = buildStretchOffers([low, high, mid], ['python', 'terraform'])
    expect(result.map(r => r.salary?.to)).toEqual([30000, 22000, 15000])
  })

  it('returns at most 3 offers even when more qualify', () => {
    const pairs = [25000, 22000, 20000, 18000, 15000].map((to, i) =>
      makePair(
        { id: `offer-${i}`, slug: `offer-${i}`, employment_types: b2bTypes(to) },
        { recommended: false, missing_skills: ['python'] },
      )
    )
    const result = buildStretchOffers(pairs, ['python'])
    expect(result).toHaveLength(3)
    expect(result[0].salary?.to).toBe(25000)
  })

  it('treats null salary as 0 for sorting (sorts to end)', () => {
    const noSalary = makePair(
      { id: 'nosalary', slug: 'nosalary', employment_types: [] },
      { recommended: false, missing_skills: ['python'] },
    )
    const withSalary = makePair(
      { id: 'withsalary', slug: 'withsalary', employment_types: b2bTypes(18000) },
      { recommended: false, missing_skills: ['python'] },
    )
    const result = buildStretchOffers([noSalary, withSalary], ['python'])
    expect(result[0].salary?.to).toBe(18000)
    expect(result[1].salary).toBeNull()
  })

  it('includes only non-rejected pairs that match — mixed recommended values', () => {
    const rejected    = makePair({ id: 'r', slug: 'r' }, { recommended: false, missing_skills: ['python'] })
    const approved    = makePair({ id: 'a', slug: 'a' }, { recommended: true,  missing_skills: ['python'] })
    const unevaluated = makePair({ id: 'u', slug: 'u' }, { recommended: null,  missing_skills: ['python'] })

    const result = buildStretchOffers([rejected, approved, unevaluated], ['python'])
    expect(result).toHaveLength(1)
  })
})
