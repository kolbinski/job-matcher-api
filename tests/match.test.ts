import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import { app } from '../src/app'
import { prisma } from '../src/lib/prisma'

afterAll(async () => {
  await prisma.$disconnect()
})

const TEST_PROFILE_PATH = 'src/data/marek-wisniewski-profile.json'

describe('POST /v1/match', () => {
  let userId = ''
  let apiKey: string

  beforeEach(async () => {
    apiKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `match-test-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: apiKey,
        profile_path: TEST_PROFILE_PATH,
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

  it('returns 422 when user has no profile_path configured', async () => {
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
  }, 180_000) // Claude API can take up to 120 s for a full batch; 180 s gives headroom

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

  it('writes one user_offer row per scanned offer', async () => {
    const res = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    const scanned: number = res.body.meta.total_offers_scanned
    const rows = await prisma.userOffer.findMany({ where: { user_id: userId } })
    // Every scanned offer must end up in user_offers (pre_filter_rejected or pending_apply)
    expect(rows.length).toBe(scanned)
  })

  it('does not re-process offers seen in a previous call', async () => {
    await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    const firstCount = await prisma.userOffer.count({ where: { user_id: userId } })

    const res2 = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    const secondCount = await prisma.userOffer.count({ where: { user_id: userId } })
    // Second call finds no new offers — all were already seen
    expect(secondCount).toBe(firstCount)
    expect(res2.body.meta.total_offers_scanned).toBe(0)
  })
})
