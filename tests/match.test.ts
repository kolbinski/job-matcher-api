import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { app } from '../src/app'
import { prisma } from '../src/lib/prisma'

afterAll(async () => {
  await prisma.$disconnect()
})

const MINIMAL_PROFILE = {
  basic_info: { full_name: 'Test User', remote_ok: true },
  technologies: [{ name: 'TypeScript' }, { name: 'Node.js' }],
  preferences: { salary_pln_net_b2b: { min: 15000, max: 25000 } },
  red_flags: [],
}

describe('POST /v1/match', () => {
  let userId = ''
  let apiKey: string

  beforeEach(async () => {
    apiKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `match-test-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: apiKey,
      },
    })
    userId = user.id
  })

  afterEach(async () => {
    if (userId) {
      await prisma.apiCall.deleteMany({ where: { user_id: userId } })
      await prisma.user.deleteMany({ where: { id: userId } })
    }
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
      .set('X-API-Key', apiKey)
      .send({ profile: { bad: 'data' } })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('INVALID_PROFILE')
  })

  it('returns valid MatchResponse for a valid key', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ profile: MINIMAL_PROFILE, options: { ai_scoring: false } })

    expect(res.status).toBe(200)
    expect(res.body.meta.call_id).toBeTruthy()
    expect(typeof res.body.meta.response_ms).toBe('number')
    expect(res.body.meta.ai_scoring).toBe(false)
    expect(Array.isArray(res.body.matched)).toBe(true)
    expect(Array.isArray(res.body.unmatched)).toBe(true)
  })

  it('returns a valid response structure when ai_scoring is enabled', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ profile: MINIMAL_PROFILE, options: { ai_scoring: true } })

    expect(res.status).toBe(200)
    expect(typeof res.body.meta.ai_scoring).toBe('boolean')
    if (res.body.matched.length > 0 && res.body.meta.ai_scoring) {
      const offer = res.body.matched[0]
      expect(['apply', 'consider', 'skip']).toContain(offer.ai_recommendation)
      expect(typeof offer.ai_summary).toBe('string')
    }
  })

  it('writes an api_calls row on success', async () => {
    await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ profile: MINIMAL_PROFILE, options: { ai_scoring: false } })

    const calls = await prisma.apiCall.findMany({ where: { user_id: userId } })
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('success')
    expect(calls[0].response_ms).toBeGreaterThan(0)
  })
})
