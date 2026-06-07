import { describe, it, expect } from 'vitest'
import type { Offer } from '@prisma/client'
import type { CandidateProfile } from '../src/types/profile'
import {
  TECH_WEIGHT,
  SALARY_WEIGHT,
  REMOTE_WEIGHT,
  EXPERIENCE_LEVEL_WEIGHT,
  scoreOffer,
  skillMatches,
} from '../src/services/scoring'
import { filterRedFlags } from '../src/services/redFlagFilter'
import { normalizeProfile } from '../src/services/profileParser'

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
    basic_info: { full_name: 'Test User' },
    technologies: {},
    preferences: {},
    red_flags: [],
    ...overrides,
  }
}

// Convenience: normalize profile and score in one call
function score(profile: CandidateProfile, offer: Offer) {
  return scoreOffer(normalizeProfile(profile), offer)
}

// ─── weights ─────────────────────────────────────────────────────────────────

describe('scoring weights', () => {
  it('sum to exactly 1.0', () => {
    expect(TECH_WEIGHT + SALARY_WEIGHT + REMOTE_WEIGHT + EXPERIENCE_LEVEL_WEIGHT).toBe(1.0)
  })
})

// ─── filterRedFlags ───────────────────────────────────────────────────────────

describe('filterRedFlags', () => {
  it('returns empty array when profile has no red flags', () => {
    expect(filterRedFlags(makeProfile({ red_flags: [] }), makeOffer({ required_skills: ['React', 'TypeScript'] }))).toHaveLength(0)
  })

  it('flags offer when it requires a forbidden technology', () => {
    const profile = makeProfile({ red_flags: [{ category: 'technology', description: 'php, cobol' }] })
    expect(filterRedFlags(profile, makeOffer({ required_skills: ['PHP', 'MySQL'] })).length).toBeGreaterThan(0)
  })

  it('does not flag when offer has no forbidden technologies', () => {
    const profile = makeProfile({ red_flags: [{ category: 'technology', description: 'php' }] })
    expect(filterRedFlags(profile, makeOffer({ required_skills: ['React', 'TypeScript'] }))).toHaveLength(0)
  })

  it('is case-insensitive when matching forbidden tech', () => {
    const profile = makeProfile({ red_flags: [{ category: 'tech', description: 'PHP' }] })
    expect(filterRedFlags(profile, makeOffer({ required_skills: ['php', 'mysql'] })).length).toBeGreaterThan(0)
  })

})

// ─── scoreOffer ───────────────────────────────────────────────────────────────

describe('scoreOffer — techScore', () => {
  it('returns 100 when candidate has all required skills', () => {
    const profile = makeProfile({ technologies: { Frontend: [{ name: 'React' }], Backend: [{ name: 'Node.js' }], Languages: [{ name: 'TypeScript' }] } })
    const result = score(profile, makeOffer({ required_skills: ['react', 'typescript', 'node.js'] }))
    expect(result.techScore).toBe(100)
    expect(result.missingSkills).toHaveLength(0)
  })

  it('returns 0 when candidate has none of the required skills', () => {
    const result = score(makeProfile({ technologies: {} }), makeOffer({ required_skills: ['react', 'typescript', 'graphql'] }))
    expect(result.techScore).toBe(0)
    expect(result.missingSkills).toHaveLength(3)
  })

  it('returns 50 when offer has no required skills', () => {
    expect(score(makeProfile({ technologies: {} }), makeOffer({ required_skills: [] })).techScore).toBe(50)
  })

  it('identifies missing skills correctly', () => {
    const profile = makeProfile({ technologies: { Frontend: [{ name: 'React' }] } })
    const result = score(profile, makeOffer({ required_skills: ['react', 'typescript', 'graphql'] }))
    expect(result.missingSkills).toContain('typescript')
    expect(result.missingSkills).toContain('graphql')
    expect(result.missingSkills).not.toContain('react')
  })

  it('weighted score is well below 50 when tech score is 0', () => {
    const result = score(makeProfile({ technologies: {} }), makeOffer({ required_skills: ['react', 'typescript'] }))
    // tech 0*0.40 + salary 50*0.25 + remote 70*0.20 + expLevel 75*0.15 = 0+12.5+14+11.25 = 37.75
    expect(result.score).toBeLessThan(45)
  })
})

describe('scoreOffer — remoteScore', () => {
  it('returns 100 for remote candidate on remote offer', () => {
    expect(score(makeProfile({ preferences: { work_model: ['remote'] } }), makeOffer({ workplace_type: 'remote' })).remoteScore).toBe(100)
  })

  it('returns 0 for remote candidate on office offer', () => {
    expect(score(makeProfile({ preferences: { work_model: ['remote'] } }), makeOffer({ workplace_type: 'office' })).remoteScore).toBe(0)
  })

  it('returns 60 for remote candidate on hybrid offer', () => {
    expect(score(makeProfile({ preferences: { work_model: ['remote'] } }), makeOffer({ workplace_type: 'hybrid' })).remoteScore).toBe(60)
  })
})

describe('scoreOffer — salaryScore', () => {
  it('returns 100 when offer salary meets candidate minimum', () => {
    const profile = makeProfile({ preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 15000 }] } })
    const offer = makeOffer({ employment_types: [{ type: 'b2b', from: 18000, to: 25000, currency: 'PLN' }] })
    expect(score(profile, offer).salaryScore).toBe(100)
  })

  it('returns less than 100 when offer salary is below candidate minimum', () => {
    const profile = makeProfile({ preferences: { salary: [{ type: 'b2b', currency: 'PLN', min: 20000 }] } })
    const offer = makeOffer({ employment_types: [{ type: 'b2b', from: 10000, to: 15000, currency: 'PLN' }] })
    const result = score(profile, offer)
    expect(result.salaryScore).toBeLessThan(100)
    expect(result.salaryScore).toBeGreaterThan(0)
  })

  it('returns 50 when no salary data available', () => {
    expect(score(makeProfile(), makeOffer({ employment_types: [] })).salaryScore).toBe(50)
  })
})

// ─── skillMatches ─────────────────────────────────────────────────────────────

describe('skillMatches', () => {
  it('matches exact skill (case-insensitive — offer skill already lowercased)', () => {
    expect(skillMatches('react', new Set(['react', 'typescript']))).toBe(true)
  })

  it('returns false when offer skill is not in candidate set', () => {
    expect(skillMatches('python', new Set(['react', 'typescript']))).toBe(false)
  })

  it('matches compound offer skill "react (typescript)" against candidate "react"', () => {
    expect(skillMatches('react (typescript)', new Set(['react']))).toBe(true)
  })

  it('matches compound offer skill "devops & ci/cd" against candidate "ci/cd"', () => {
    expect(skillMatches('devops & ci/cd', new Set(['ci/cd']))).toBe(true)
  })

  it('matches when candidate tech is longer and contains offer skill', () => {
    expect(skillMatches('node', new Set(['node.js']))).toBe(true)
  })

  it('does not match unrelated compound skill', () => {
    expect(skillMatches('java (spring)', new Set(['react', 'typescript']))).toBe(false)
  })
})

// ─── techScore with compound skills ──────────────────────────────────────────

describe('techScore — compound skill matching', () => {
  it('matches "react (typescript)" offer skill when candidate has "react"', () => {
    const profile = makeProfile({ technologies: { Frontend: [{ name: 'react' }, { name: 'node.js' }] } })
    const offer = makeOffer({ required_skills: ['react (typescript)', 'node.js'] })
    const result = score(profile, offer)
    expect(result.techScore).toBe(100)
    expect(result.missingSkills).toHaveLength(0)
  })

  it('case-insensitive: "React" offer skill matches candidate "react"', () => {
    const profile = makeProfile({ technologies: { Frontend: [{ name: 'react' }] } })
    const offer = makeOffer({ required_skills: ['React'] })
    const result = score(profile, offer)
    expect(result.techScore).toBe(100)
  })

  it('compound unmatched skill appears in missingSkills', () => {
    const profile = makeProfile({ technologies: { Frontend: [{ name: 'react' }] } })
    const offer = makeOffer({ required_skills: ['python (django)', 'react'] })
    const result = score(profile, offer)
    expect(result.missingSkills).toContain('python (django)')
    expect(result.missingSkills).not.toContain('react')
  })
})
