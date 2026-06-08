import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Offer } from '@prisma/client'
import { app } from '../src/app'
import { prisma } from '../src/lib/prisma'
import { createFixtureOffers, deleteFixtureOffers } from '../src/test/fixtures'

vi.mock('../src/services/claudeEvaluator', () => ({
  evaluateOffers: vi.fn((_profile: unknown, offers: unknown[]) =>
    Promise.resolve(
      offers.map((_, i) => ({
        offer_index: i,
        score: 75,
        rank: i + 1,
        matched_reasons: ['Good tech match'] as string[],
        missing_skills: [] as string[],
        salary_comparison: 'Within range',
        role_fit: 'Strong match for the candidate profile.',
        recommended: true,
      }))
    )
  ),
}))

const TEST_PROFILE_PATH = 'src/data/marek-wisniewski-profile.json'
const TEST_PROFILE = JSON.parse(fs.readFileSync(path.resolve(TEST_PROFILE_PATH), 'utf-8')) as object

const origFindMany = prisma.offer.findMany.bind(prisma.offer)

let fixtureOffers: Offer[] = []

beforeAll(async () => {
  await deleteFixtureOffers() // clear any leftovers from interrupted previous runs
  fixtureOffers = await createFixtureOffers()

  // Return only the 6 controlled fixtures instead of loading 8000+ live offers.
  // id.in queries (FK existence checks) pass through to the real DB so the
  // pre_filter_rejected createMany doesn't skip valid fixture offer IDs.
  // The skill-excluded query (id.notIn + select.id) still returns [] so scanned = 6.
  // Cast to any: PrismaPromise vs Promise mismatch is irrelevant at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(vi.spyOn(prisma.offer, 'findMany') as any).mockImplementation(async (args?: any) => {
    if (args?.where?.id?.in) return origFindMany(args)
    if (args?.select?.id) return []
    return fixtureOffers
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await deleteFixtureOffers()
  await prisma.$disconnect()
})

describe('POST /v1/match', () => {
  let userId = ''
  let apiKey: string

  beforeEach(async () => {
    apiKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `match-test-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: apiKey,
        profile: TEST_PROFILE,
      },
    })
    userId = user.id
  })

  afterEach(async () => {
    if (userId) {
      await prisma.userOffer.deleteMany({ where: { user_id: userId } })
      await prisma.apiCall.deleteMany({ where: { user_id: userId } })
      await prisma.user.deleteMany({ where: { id: userId } })
    }
  })

  it('returns 401 with no API key', async () => {
    const res = await request(app).post('/v1/match').send({})
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('INVALID_API_KEY')
  })

  it('returns 401 with unknown API key', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', 'jm_live_unknownkeyxxxxxxxxxxxxxx')
      .send({})
    expect(res.status).toBe(401)
  })

  it('returns 422 when user has no profile configured', async () => {
    const noProfileKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const noProfileUser = await prisma.user.create({
      data: {
        email: `no-profile-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: noProfileKey,
      },
    })
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', noProfileKey)
      .send({})
    await prisma.user.delete({ where: { id: noProfileUser.id } })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('INVALID_PROFILE')
  })

  it('returns valid MatchResponse for a valid key', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    expect(res.status).toBe(200)
    expect(res.body.meta.call_id).toBeTruthy()
    expect(typeof res.body.meta.response_ms).toBe('number')
    expect(res.body.meta.ai_scoring).toBe(false)
    expect(Array.isArray(res.body.matched)).toBe(true)
    expect(Array.isArray(res.body.unmatched)).toBe(true)
    expect(Array.isArray(res.body.stretch_offers)).toBe(true)
  })

  it('returns a valid response structure when ai_scoring is enabled', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: true } })

    expect(res.status).toBe(200)
    expect(typeof res.body.meta.ai_scoring).toBe('boolean')
    if (res.body.matched.length > 0 && res.body.meta.ai_scoring) {
      const offer = res.body.matched[0]
      expect(typeof offer.recommended).toBe('boolean')
      expect(typeof offer.role_fit).toBe('string')
    }
  })

  it('writes an api_calls row on success', async () => {
    await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    const calls = await prisma.apiCall.findMany({ where: { user_id: userId } })
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('success')
    expect(calls[0].response_ms).toBeGreaterThan(0)
  })

  it('writes user_offer rows for pre-filtered offers; skips unscored matched offers', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    const scanned: number = res.body.meta.total_offers_scanned
    const matched: number = res.body.meta.matched_count
    const rows = await prisma.userOffer.findMany({ where: { user_id: userId } })
    // Pre-filter rejected offers are inserted; matched offers with null claude_score
    // (ai_scoring: false) are skipped to prevent pending_apply rows with no Claude data.
    expect(rows.length).toBe(scanned - matched)
    expect(rows.every(r => r.status !== 'pending_apply' || r.claude_score !== null)).toBe(true)
  })
})
