import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { app } from '../src/app'
import { prisma } from '../src/lib/prisma'

afterAll(async () => {
  await prisma.$disconnect()
})

// Minimal valid profile matching the CandidateProfile Zod schema
const MINIMAL_PROFILE = {
  basic_info: { full_name: 'Test User', remote_ok: true },
  technologies: [{ name: 'TypeScript' }, { name: 'Node.js' }],
  preferences: { salary_pln_net_b2b: { min: 15000, max: 25000 } },
  red_flags: [],
}

describe('POST /v1/match', () => {
  let userId: string
  let testKey: string
  let liveKey: string

  beforeEach(async () => {
    testKey = `jm_test_${crypto.randomBytes(16).toString('hex')}`
    liveKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `match-test-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: testKey,
        credits: new Prisma.Decimal('5.00'),
      },
    })
    userId = user.id
  })

  afterEach(async () => {
    await prisma.apiCall.deleteMany({ where: { user_id: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  })

  it('returns 401 with no API key', async () => {
    const res = await request(app).post('/v1/match').send({ profile: MINIMAL_PROFILE })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('INVALID_API_KEY')
  })

  it('returns 401 with unknown API key', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', 'jm_live_unknownkeyxxxxxxxxxxxxxx')
      .send({ profile: MINIMAL_PROFILE })
    expect(res.status).toBe(401)
  })

  it('returns 422 with invalid profile body', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', testKey)
      .send({ profile: { bad: 'data' } })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('INVALID_PROFILE')
  })

  it('returns valid MatchResponse for jm_test_ key (no AI, no offers)', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', testKey)
      .send({ profile: MINIMAL_PROFILE, options: { ai_scoring: false } })

    expect(res.status).toBe(200)

    const body = res.body
    expect(body.meta).toBeDefined()
    expect(body.meta.call_id).toBeTruthy()
    expect(typeof body.meta.response_ms).toBe('number')
    expect(body.meta.credits_used).toBe(0) // test key — no charge
    expect(body.meta.ai_scoring).toBe(false)
    expect(Array.isArray(body.matched)).toBe(true)
    expect(Array.isArray(body.unmatched)).toBe(true)
  })

  it('writes an api_calls row with cost=0 for jm_test_ key', async () => {
    await request(app)
      .post('/v1/match')
      .set('X-API-Key', testKey)
      .send({ profile: MINIMAL_PROFILE, options: { ai_scoring: false } })

    const calls = await prisma.apiCall.findMany({ where: { user_id: userId } })
    expect(calls).toHaveLength(1)
    expect(calls[0].cost.equals(new Prisma.Decimal(0))).toBe(true)
    expect(calls[0].status).toBe('success')
    expect(calls[0].response_ms).toBeGreaterThan(0)
  })

  it('deducts credits for jm_live_ key', async () => {
    // Create a second user with a live key for this test
    const liveUser = await prisma.user.create({
      data: {
        email: `live-match-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: liveKey,
        credits: new Prisma.Decimal('5.00'),
      },
    })

    try {
      await request(app)
        .post('/v1/match')
        .set('X-API-Key', liveKey)
        .send({ profile: MINIMAL_PROFILE, options: { ai_scoring: false } })

      const setting = await prisma.settings.findUnique({ where: { key: 'call_cost' } })
      const updated = await prisma.user.findUnique({ where: { id: liveUser.id } })
      const expectedCredits = new Prisma.Decimal('5.00').sub(
        new Prisma.Decimal(setting!.value)
      )
      expect(updated!.credits.equals(expectedCredits)).toBe(true)
    } finally {
      await prisma.apiCall.deleteMany({ where: { user_id: liveUser.id } })
      await prisma.user.delete({ where: { id: liveUser.id } })
    }
  })

  it('returns 402 when jm_live_ key has insufficient credits', async () => {
    const brokeUser = await prisma.user.create({
      data: {
        email: `broke-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: `jm_live_${crypto.randomBytes(16).toString('hex')}`,
        credits: new Prisma.Decimal('0.00'),
      },
    })

    try {
      const res = await request(app)
        .post('/v1/match')
        .set('X-API-Key', brokeUser.jobmatcher_api_key)
        .send({ profile: MINIMAL_PROFILE, options: { ai_scoring: false } })

      expect(res.status).toBe(402)
      expect(res.body.error).toBe('INSUFFICIENT_CREDITS')
    } finally {
      await prisma.user.delete({ where: { id: brokeUser.id } })
    }
  })
})
