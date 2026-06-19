import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from '../src/app'
import { prisma } from '../src/lib/prisma'

// Profile on disk has preferences.learning_skills_goals: ['python', 'terraform']
const TEST_PROFILE_PATH = 'src/data/marek-wisniewski-profile.json'
const TEST_PROFILE = JSON.parse(fs.readFileSync(path.resolve(TEST_PROFILE_PATH), 'utf-8')) as object
const TEST_SLUG_PREFIX = 'test-stretch-'

// Capture the real findMany before spying so the stretch-offer lookup
// (id: { in: [...] }) passes through to the real DB.
const origFindMany = prisma.offer.findMany.bind(prisma.offer)

beforeAll(() => {
  // Return [] for the main active-offers scan (test offers are is_active:false and
  // already in seenIds). Pass through queries with id.in so buildStretchOffers can
  // load the specific test offers it needs.
  // Cast to any: PrismaPromise vs Promise mismatch is irrelevant at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(vi.spyOn(prisma.offer, 'findMany') as any).mockImplementation(async (args?: any) => {
    if (args?.where?.id?.in) return origFindMany(args)
    return []
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await prisma.$disconnect()
})

describe('stretch_offers — DB integration', () => {
  let userId = ''
  let apiKey: string
  let pythonOfferSlug = ''
  let javaOfferSlug = ''

  beforeEach(async () => {
    const rand = crypto.randomBytes(4).toString('hex')
    pythonOfferSlug = `${TEST_SLUG_PREFIX}python-${rand}`
    javaOfferSlug  = `${TEST_SLUG_PREFIX}java-${rand}`

    apiKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `stretch-test-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: apiKey,
        profile: TEST_PROFILE,
      },
    })
    userId = user.id

    // Inactive so the skillExcluded query (is_active:true) never picks them up,
    // avoiding FK violations when afterEach deletes them while another test is
    // mid-insert. Safe to use is_active:false now that buildStretchOffers uses
    // two separate queries instead of include:{offer:true} INNER JOIN.
    const pythonOffer = await prisma.offer.create({
      data: {
        slug: pythonOfferSlug,
        source: 'test',
        title: 'Python Backend Engineer',
        company_name: 'StretchTestCo',
        employment_types: [{ type: 'contract', from: 20000, to: 25000, currency: 'PLN' }],
        required_skills: ['python', 'django'],
        nice_to_have_skills: [],
        languages: [],
        is_active: false,
      },
    })

    const javaOffer = await prisma.offer.create({
      data: {
        slug: javaOfferSlug,
        source: 'test',
        title: 'Java Developer',
        company_name: 'OtherTestCo',
        employment_types: [{ type: 'contract', from: 15000, to: 18000, currency: 'PLN' }],
        required_skills: ['java', 'spring'],
        nice_to_have_skills: [],
        languages: [],
        is_active: false,
      },
    })

    // Simulate prior Claude evaluations stored in user_offers
    await prisma.userOffer.createMany({
      data: [
        {
          user_id: userId,
          offer_id: pythonOffer.id,
          status: 'ai_rejected',
          missing_skills: ['python', 'django'],  // overlaps with learning_skills_goals
          claude_role_fit: 'Missing Python experience',
          claude_matched_reasons: [],
          matched_at: new Date(),
          updated_at: new Date(),
        },
        {
          user_id: userId,
          offer_id: javaOffer.id,
          status: 'ai_rejected',
          missing_skills: ['java', 'spring'],    // no overlap with learning_skills_goals
          claude_role_fit: 'Missing Java experience',
          claude_matched_reasons: [],
          matched_at: new Date(),
          updated_at: new Date(),
        },
      ],
    })
  })

  afterEach(async () => {
    if (userId) {
      await prisma.userOffer.deleteMany({ where: { user_id: userId } })
      await prisma.apiCall.deleteMany({ where: { user_id: userId } })
      await prisma.user.deleteMany({ where: { id: userId } })
    }
    await prisma.offer.deleteMany({ where: { slug: { in: [pythonOfferSlug, javaOfferSlug] } } })
  })

  it('includes ai_rejected offer whose missing_skills overlap with learning_skills_goals', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.stretch_offers)).toBe(true)

    const stretch = res.body.stretch_offers as Array<{
      title: string
      company_name: string
      missing_skills: string[]
      role_fit: string | null
      salary: { from: number; to: number; currency: string; type: string } | null
      url: string | null
    }>

    const match = stretch.find(o => o.company_name === 'StretchTestCo')
    expect(match).toBeDefined()
    expect(match?.title).toBe('Python Backend Engineer')
    expect(match?.missing_skills).toContain('python')
    expect(match?.role_fit).toBe('Missing Python experience')
    expect(match?.salary?.to).toBe(25000)
    expect(match?.salary?.currency).toBe('PLN')
  })

  it('excludes ai_rejected offer with no learning_skills_goals overlap', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    expect(res.status).toBe(200)

    const stretch = res.body.stretch_offers as Array<{ company_name: string }>
    expect(stretch.find(o => o.company_name === 'OtherTestCo')).toBeUndefined()
  })
})
