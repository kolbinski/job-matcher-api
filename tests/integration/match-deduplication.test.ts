// @slow — hits real DB with 8000+ rows; run via: npm run test:integration
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from '../../src/app'
import { prisma } from '../../src/lib/prisma'

vi.mock('../../src/services/claudeEvaluator', () => ({
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

const TEST_PROFILE = JSON.parse(fs.readFileSync(path.resolve('src/data/marek-wisniewski-profile.json'), 'utf-8')) as object

afterAll(async () => {
  await prisma.$disconnect()
})

describe('POST /v1/match — deduplication (integration)', () => {
  let userId = ''
  let apiKey: string

  beforeEach(async () => {
    apiKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `match-dedup-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
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

  it('does not re-process pre-filtered offers seen in a previous call', async () => {
    const res1 = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    const firstCount = await prisma.userOffer.count({ where: { user_id: userId } })

    const res2 = await request(app)
      .post('/v1/match')
      .set('X-API-Key', apiKey)
      .send({ options: { ai_scoring: false } })

    const secondCount = await prisma.userOffer.count({ where: { user_id: userId } })
    // secondCount >= firstCount: previously-seen offers are never re-inserted
    // (skipDuplicates + seenIds). New offers may have arrived via live Apify cron
    // between the two calls, so strict equality is brittle against live data.
    expect(secondCount).toBeGreaterThanOrEqual(firstCount)
    // Call 2 should scan far fewer offers than call 1 — only unscored matched
    // offers from call 1 plus any newly arrived offers. Previously-written
    // pre_filter/skill_excluded rows are excluded via seenIds.
    expect(res2.body.meta.total_offers_scanned).toBeLessThan(res1.body.meta.total_offers_scanned)
  }, 300_000)
})
