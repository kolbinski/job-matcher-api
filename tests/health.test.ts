import { describe, it, expect, afterAll } from 'vitest'
import request from 'supertest'
import { app } from '../src/app'
import { prisma } from '../src/lib/prisma'

afterAll(async () => {
  await prisma.$disconnect()
})

describe('GET /v1/health', () => {
  it('returns 200 with status ok and expected fields', async () => {
    const res = await request(app).get('/v1/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.offers_count).toBe('number')
    expect(
      res.body.last_cronjob === null || typeof res.body.last_cronjob === 'string'
    ).toBe(true)
  })
})
