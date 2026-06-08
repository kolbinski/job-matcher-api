import { describe, it, expect } from 'vitest'
import type { Offer } from '@prisma/client'
import type { CandidateProfile } from '../src/types/profile'
import { applyPreFilters } from '../src/services/redFlagFilter'

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'test-id',
    slug: 'test-slug',
    is_active: true,
    source: 'justjoin',
    title: 'Software Engineer',
    company_name: 'Acme Corp',
    company_logo_url: null,
    experience_level: 'mid',
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
    url: null,
    published_at: null,
    fetched_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function makeProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    basic_info: { first_name: 'Test', last_name: 'User' },
    skills: {},
    preferences: {},
    red_flags: [],
    ...overrides,
  }
}

// ─── WORKPLACE FILTER ────────────────────────────────────────────────────────

describe('workplace filter', () => {
  it('rejects office when candidate only accepts remote', () => {
    const profile = makeProfile({ preferences: { work_model: ['remote'] } })
    const result = applyPreFilters(profile, makeOffer({ workplace_type: 'office' }))
    expect(result.pass).toBe(false)
    expect(result.rejectedByWorkplace).toBe(true)
  })

  it('rejects hybrid when candidate only accepts remote', () => {
    const profile = makeProfile({ preferences: { work_model: ['remote'] } })
    const result = applyPreFilters(profile, makeOffer({ workplace_type: 'hybrid' }))
    expect(result.pass).toBe(false)
    expect(result.rejectedByWorkplace).toBe(true)
  })

  it('passes remote when candidate accepts remote', () => {
    const profile = makeProfile({ preferences: { work_model: ['remote'] } })
    const result = applyPreFilters(profile, makeOffer({ workplace_type: 'remote' }))
    expect(result.pass).toBe(true)
    expect(result.rejectedByWorkplace).toBe(false)
  })

  it('rejects office when candidate accepts remote and hybrid', () => {
    const profile = makeProfile({ preferences: { work_model: ['remote', 'hybrid'] } })
    const result = applyPreFilters(profile, makeOffer({ workplace_type: 'office' }))
    expect(result.pass).toBe(false)
    expect(result.rejectedByWorkplace).toBe(true)
  })

  it('passes remote when candidate accepts remote and hybrid', () => {
    const profile = makeProfile({ preferences: { work_model: ['remote', 'hybrid'] } })
    const result = applyPreFilters(profile, makeOffer({ workplace_type: 'remote' }))
    expect(result.pass).toBe(true)
    expect(result.rejectedByWorkplace).toBe(false)
  })

  it('passes hybrid when candidate accepts remote and hybrid', () => {
    const profile = makeProfile({ preferences: { work_model: ['remote', 'hybrid'] } })
    const result = applyPreFilters(profile, makeOffer({ workplace_type: 'hybrid' }))
    expect(result.pass).toBe(true)
    expect(result.rejectedByWorkplace).toBe(false)
  })

  it('treats partly_remote as hybrid — pass when candidate accepts hybrid', () => {
    const profile = makeProfile({ preferences: { work_model: ['hybrid'] } })
    const result = applyPreFilters(profile, makeOffer({ workplace_type: 'partly_remote' }))
    expect(result.pass).toBe(true)
    expect(result.rejectedByWorkplace).toBe(false)
  })

  it('treats partly_remote as hybrid — reject when candidate only accepts remote', () => {
    const profile = makeProfile({ preferences: { work_model: ['remote'] } })
    const result = applyPreFilters(profile, makeOffer({ workplace_type: 'partly_remote' }))
    expect(result.pass).toBe(false)
    expect(result.rejectedByWorkplace).toBe(true)
  })
})

// ─── EMPLOYMENT TYPE FILTER ───────────────────────────────────────────────────

describe('employment type filter', () => {
  it('rejects offer with only permanent when candidate wants b2b', () => {
    const profile = makeProfile({ preferences: { employment_type: ['b2b'] } })
    const offer = makeOffer({ employment_types: [{ type: 'permanent', from: 10000, to: 20000, currency: 'PLN' }] })
    const result = applyPreFilters(profile, offer)
    expect(result.pass).toBe(false)
    expect(result.rejectedByEmploymentType).toBe(true)
  })

  it('passes offer with b2b when candidate wants b2b', () => {
    const profile = makeProfile({ preferences: { employment_type: ['b2b'] } })
    const offer = makeOffer({ employment_types: [{ type: 'b2b', from: 18000, to: 25000, currency: 'PLN' }] })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedByEmploymentType).toBe(false)
  })

  it('passes offer with b2b when candidate wants b2b and permanent', () => {
    const profile = makeProfile({ preferences: { employment_type: ['b2b', 'permanent'] } })
    const offer = makeOffer({ employment_types: [{ type: 'b2b', from: 18000, to: 25000, currency: 'PLN' }] })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedByEmploymentType).toBe(false)
  })

  it('passes offer with permanent when candidate wants b2b and permanent', () => {
    const profile = makeProfile({ preferences: { employment_type: ['b2b', 'permanent'] } })
    const offer = makeOffer({ employment_types: [{ type: 'permanent', from: 12000, to: 18000, currency: 'PLN' }] })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedByEmploymentType).toBe(false)
  })

  it('passes offer with no employment_types declared (undisclosed)', () => {
    const profile = makeProfile({ preferences: { employment_type: ['b2b'] } })
    const offer = makeOffer({ employment_types: [] })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedByEmploymentType).toBe(false)
  })

  it('passes offer with type "any" even when candidate wants b2b', () => {
    const profile = makeProfile({ preferences: { employment_type: ['b2b'] } })
    const offer = makeOffer({ employment_types: [{ type: 'any', currency: 'PLN' }] })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedByEmploymentType).toBe(false)
  })

  it('deduplicates repeated types in rejection reason', () => {
    const profile = makeProfile({ preferences: { employment_type: ['b2b'] } })
    const offer = makeOffer({
      employment_types: [
        { type: 'permanent', currency: 'PLN' },
        { type: 'permanent', currency: 'EUR' },
        { type: 'permanent', currency: 'USD' },
      ],
    })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedByEmploymentType).toBe(true)
    expect(result.reasons[0]).toBe('Offer only provides permanent contract but candidate wants b2b')
  })
})

// ─── SALARY FILTER ────────────────────────────────────────────────────────────

describe('salary filter', () => {
  it('rejects when monthly b2b PLN ceiling < candidate min (unit=Month)', () => {
    const profile = makeProfile({
      preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 22000 }] },
    })
    const offer = makeOffer({
      employment_types: [{ type: 'b2b', from: 10000, to: 18000, currency: 'PLN', unit: 'Month' }],
    })
    const result = applyPreFilters(profile, offer)
    expect(result.pass).toBe(false)
    expect(result.rejectedBySalary).toBe(true)
  })

  it('passes when monthly b2b PLN ceiling >= candidate min (unit=Month)', () => {
    const profile = makeProfile({
      preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 22000 }] },
    })
    const offer = makeOffer({
      employment_types: [{ type: 'b2b', from: 20000, to: 25000, currency: 'PLN', unit: 'Month' }],
    })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedBySalary).toBe(false)
  })

  it('rejects when daily b2b PLN ceiling * 20 < candidate min (unit=Day)', () => {
    // 1000/day * 20 = 20000 < 22000 → reject
    const profile = makeProfile({
      preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 22000 }] },
    })
    const offer = makeOffer({
      employment_types: [{ type: 'b2b', from: 800, to: 1000, currency: 'PLN', unit: 'Day' }],
    })
    const result = applyPreFilters(profile, offer)
    expect(result.pass).toBe(false)
    expect(result.rejectedBySalary).toBe(true)
  })

  it('passes when daily b2b PLN ceiling * 20 >= candidate min (unit=Day)', () => {
    // 1200/day * 20 = 24000 >= 22000 → pass
    const profile = makeProfile({
      preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 22000 }] },
    })
    const offer = makeOffer({
      employment_types: [{ type: 'b2b', from: 1000, to: 1200, currency: 'PLN', unit: 'Day' }],
    })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedBySalary).toBe(false)
  })

  it('passes when offer has no matching currency (salary not disclosed for that currency)', () => {
    const profile = makeProfile({
      preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 22000 }] },
    })
    const offer = makeOffer({
      employment_types: [{ type: 'b2b', from: 5000, to: 8000, currency: 'EUR', unit: 'Month' }],
    })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedBySalary).toBe(false)
  })

  it('passes when offer has no matching employment type (salary not disclosed for that type)', () => {
    const profile = makeProfile({
      preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 22000 }] },
    })
    const offer = makeOffer({
      employment_types: [{ type: 'permanent', from: 10000, to: 15000, currency: 'PLN', unit: 'Month' }],
    })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedBySalary).toBe(false)
  })

  it('passes when offer has no employment_types at all', () => {
    const profile = makeProfile({
      preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 22000 }] },
    })
    const offer = makeOffer({ employment_types: [] })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedBySalary).toBe(false)
  })

  it('passes permanent offer 15000-22000 when candidate has b2b min 22000 + permanent min 15000', () => {
    const profile = makeProfile({
      preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 22000 }, { type: 'permanent', currency: 'PLN', min: 15000 }] },
    })
    const offer = makeOffer({
      employment_types: [{ type: 'permanent', from: 12000, to: 18000, currency: 'PLN', unit: 'Month' }],
    })
    const result = applyPreFilters(profile, offer)
    expect(result.rejectedBySalary).toBe(false)
  })

  it('rejects b2b offer 15000-22000 when candidate has b2b min 22000 + permanent min 15000', () => {
    const profile = makeProfile({
      preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 22000 }, { type: 'permanent', currency: 'PLN', min: 15000 }] },
    })
    const offer = makeOffer({
      employment_types: [{ type: 'b2b', from: 12000, to: 18000, currency: 'PLN', unit: 'Month' }],
    })
    const result = applyPreFilters(profile, offer)
    expect(result.pass).toBe(false)
    expect(result.rejectedBySalary).toBe(true)
  })
})

// ─── SENIORITY FILTER ────────────────────────────────────────────────────────

describe('seniority filter', () => {
  it('rejects junior offer for senior candidate (gap > 1)', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', experience_level: 'senior' } })
    const result = applyPreFilters(profile, makeOffer({ experience_level: 'junior' }))
    expect(result.pass).toBe(false)
    expect(result.rejectedBySeniority).toBe(true)
  })

  it('passes senior offer for senior candidate', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', experience_level: 'senior' } })
    const result = applyPreFilters(profile, makeOffer({ experience_level: 'senior' }))
    expect(result.rejectedBySeniority).toBe(false)
  })

  it('passes mid offer for senior candidate (gap = 1)', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', experience_level: 'senior' } })
    const result = applyPreFilters(profile, makeOffer({ experience_level: 'mid' }))
    expect(result.rejectedBySeniority).toBe(false)
  })

  it('rejects c-level offer for mid candidate (gap > 1)', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', experience_level: 'mid' } })
    const result = applyPreFilters(profile, makeOffer({ experience_level: 'c-level' }))
    expect(result.pass).toBe(false)
    expect(result.rejectedBySeniority).toBe(true)
  })

  it('passes senior offer for mid candidate (gap = 1)', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', experience_level: 'mid' } })
    const result = applyPreFilters(profile, makeOffer({ experience_level: 'senior' }))
    expect(result.rejectedBySeniority).toBe(false)
  })

  it('passes mid offer for mid candidate', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', experience_level: 'mid' } })
    const result = applyPreFilters(profile, makeOffer({ experience_level: 'mid' }))
    expect(result.rejectedBySeniority).toBe(false)
  })

  it('passes any offer when offer experience_level is null', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', experience_level: 'senior' } })
    const result = applyPreFilters(profile, makeOffer({ experience_level: null }))
    expect(result.rejectedBySeniority).toBe(false)
  })

  it('passes any offer when candidate has no experience_level set', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User' } })
    const result = applyPreFilters(profile, makeOffer({ experience_level: 'junior' }))
    expect(result.rejectedBySeniority).toBe(false)
  })
})

// ─── RED FLAG FILTER ──────────────────────────────────────────────────────────

describe('red flag filter — technology', () => {
  it('rejects when required_skills contains forbidden tech (php)', () => {
    const profile = makeProfile({
      red_flags: [{ category: 'technology', description: 'php' }],
    })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['php', 'mysql'] }))
    expect(result.pass).toBe(false)
    expect(result.rejectedByRedFlags).toBe(true)
  })

  it('passes when required_skills contains phpstorm (word boundary — not php)', () => {
    const profile = makeProfile({
      red_flags: [{ category: 'technology', description: 'php' }],
    })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['phpstorm', 'css'] }))
    expect(result.rejectedByRedFlags).toBe(false)
  })

  it('is case-insensitive: rejects PHP when flag is php', () => {
    const profile = makeProfile({
      red_flags: [{ category: 'technology', description: 'php' }],
    })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['PHP', 'MySQL'] }))
    expect(result.rejectedByRedFlags).toBe(true)
  })

  it('passes when required_skills does not contain the forbidden tech', () => {
    const profile = makeProfile({
      red_flags: [{ category: 'technology', description: 'php' }],
    })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['react', 'typescript'] }))
    expect(result.rejectedByRedFlags).toBe(false)
  })
})

describe('red flag filter — workplace via pre-filter', () => {
  it('rejects when offer is office and candidate work_model excludes office', () => {
    const profile = makeProfile({ preferences: { work_model: ['remote', 'hybrid'] } })
    const result = applyPreFilters(profile, makeOffer({ workplace_type: 'office' }))
    expect(result.pass).toBe(false)
    expect(result.rejectedByWorkplace).toBe(true)
  })
})

// ─── LANGUAGE FILTER ──────────────────────────────────────────────────────────

describe('language filter', () => {
  it('rejects when offer requires german and candidate only speaks english and polish', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', languages: ['english', 'polish'] } })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['typescript', 'german language'] }))
    expect(result.pass).toBe(false)
    expect(result.rejectedByLanguage).toBe(true)
  })

  it('passes when candidate speaks the required language', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', languages: ['english', 'polish'] } })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['typescript', 'english'] }))
    expect(result.rejectedByLanguage).toBe(false)
  })

  it('detects deutsch as german', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', languages: ['english'] } })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['java', 'deutsch'] }))
    expect(result.rejectedByLanguage).toBe(true)
  })

  it('detects język angielski as english and rejects when candidate lacks it', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', languages: ['polish'] } })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['react', 'język angielski'] }))
    expect(result.rejectedByLanguage).toBe(true)
  })

  it('detects język angielski as english and passes when candidate speaks english', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', languages: ['polish', 'english'] } })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['react', 'język angielski'] }))
    expect(result.rejectedByLanguage).toBe(false)
  })

  it('skips language filter when candidate has no languages set', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User' } })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['typescript', 'german language'] }))
    expect(result.rejectedByLanguage).toBe(false)
  })

  it('skips language filter when candidate languages array is empty', () => {
    const profile = makeProfile({ basic_info: { first_name: 'Test', last_name: 'User', languages: [] } })
    const result = applyPreFilters(profile, makeOffer({ required_skills: ['typescript', 'french language'] }))
    expect(result.rejectedByLanguage).toBe(false)
  })
})
