import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../src/lib/prisma'
import { billCall } from '../src/services/billing'
import { validateApiKey } from '../src/middleware/validateApiKey'
import { checkCredits } from '../src/middleware/checkCredits'
import { InvalidApiKeyError, InsufficientCreditsError } from '../src/lib/errors'

afterAll(async () => {
  await prisma.$disconnect()
})

// ─── billCall service ─────────────────────────────────────────────────────────

describe('billCall', () => {
  let userId: string
  let liveKey: string

  beforeEach(async () => {
    liveKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `test-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: liveKey,
        credits: new Prisma.Decimal('1.00'),
      },
    })
    userId = user.id
  })

  afterEach(async () => {
    await prisma.apiCall.deleteMany({ where: { user_id: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  })

  it('deducts call_cost from credits and writes api_calls row for live key', async () => {
    const callId = await billCall({
      userId,
      apiKeyType: 'live',
      profileJson: '{"test":true}',
      status: 'success',
    })

    const setting = await prisma.settings.findUnique({ where: { key: 'call_cost' } })
    const user = await prisma.user.findUnique({ where: { id: userId } })
    const call = await prisma.apiCall.findUnique({ where: { id: callId } })

    const expectedCredits = new Prisma.Decimal('1.00').sub(new Prisma.Decimal(setting!.value))

    expect(user!.credits.equals(expectedCredits)).toBe(true)
    expect(call!.cost.equals(new Prisma.Decimal(setting!.value))).toBe(true)
    expect(call!.status).toBe('success')
    expect(call!.profile_hash).toHaveLength(64) // SHA-256 hex
  })

  it('throws InsufficientCreditsError and rolls back when credits are too low', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { credits: new Prisma.Decimal('0.00') },
    })

    await expect(
      billCall({ userId, apiKeyType: 'live', profileJson: '{}', status: 'success' })
    ).rejects.toThrow(InsufficientCreditsError)

    const user = await prisma.user.findUnique({ where: { id: userId } })
    const calls = await prisma.apiCall.findMany({ where: { user_id: userId } })

    expect(user!.credits.equals(new Prisma.Decimal('0.00'))).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('skips deduction and writes cost=0 api_calls row for test key', async () => {
    const callId = await billCall({
      userId,
      apiKeyType: 'test',
      profileJson: '{}',
      status: 'success',
    })

    const user = await prisma.user.findUnique({ where: { id: userId } })
    const call = await prisma.apiCall.findUnique({ where: { id: callId } })

    expect(user!.credits.equals(new Prisma.Decimal('1.00'))).toBe(true)
    expect(call!.cost.equals(new Prisma.Decimal('0'))).toBe(true)
  })

  it('rolls back — no deduction, no api_calls row — when transaction errors', async () => {
    await expect(
      billCall({
        userId: '00000000-0000-0000-0000-000000000000',
        apiKeyType: 'live',
        profileJson: '{}',
        status: 'success',
      })
    ).rejects.toThrow()

    const user = await prisma.user.findUnique({ where: { id: userId } })
    const calls = await prisma.apiCall.findMany({ where: { user_id: userId } })

    expect(user!.credits.equals(new Prisma.Decimal('1.00'))).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

// ─── validateApiKey middleware ────────────────────────────────────────────────

describe('validateApiKey', () => {
  let userId: string
  let liveKey: string

  beforeEach(async () => {
    liveKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `test-mid-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: liveKey,
        credits: new Prisma.Decimal('1.00'),
      },
    })
    userId = user.id
  })

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: userId } })
  })

  it('attaches user and apiKeyType=live to req for a valid jm_live_ key', async () => {
    const req = { headers: { 'x-api-key': liveKey } } as unknown as Request
    const next = vi.fn() as unknown as NextFunction

    await validateApiKey(req, {} as Response, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.user?.id).toBe(userId)
    expect(req.apiKeyType).toBe('live')
  })

  it('throws InvalidApiKeyError when X-API-Key header is missing', async () => {
    const req = { headers: {} } as unknown as Request

    await expect(
      validateApiKey(req, {} as Response, vi.fn() as unknown as NextFunction)
    ).rejects.toThrow(InvalidApiKeyError)
  })

  it('throws InvalidApiKeyError for an unknown key', async () => {
    const req = {
      headers: { 'x-api-key': `jm_live_${'x'.repeat(32)}` },
    } as unknown as Request

    await expect(
      validateApiKey(req, {} as Response, vi.fn() as unknown as NextFunction)
    ).rejects.toThrow(InvalidApiKeyError)
  })

  it('throws InvalidApiKeyError for a key with invalid prefix', async () => {
    const req = {
      headers: { 'x-api-key': 'sk_live_someinvalidkey' },
    } as unknown as Request

    await expect(
      validateApiKey(req, {} as Response, vi.fn() as unknown as NextFunction)
    ).rejects.toThrow(InvalidApiKeyError)
  })
})

// ─── checkCredits middleware ──────────────────────────────────────────────────

describe('checkCredits', () => {
  it('sets callCost=0 and calls next for test key without touching DB', async () => {
    const req = { apiKeyType: 'test' } as unknown as Request
    const next = vi.fn() as unknown as NextFunction

    await checkCredits(req, {} as Response, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.callCost?.equals(new Prisma.Decimal(0))).toBe(true)
  })

  it('throws InsufficientCreditsError when user credits < call_cost', async () => {
    const req = {
      apiKeyType: 'live',
      user: { credits: new Prisma.Decimal('0.00') },
    } as unknown as Request

    await expect(
      checkCredits(req, {} as Response, vi.fn() as unknown as NextFunction)
    ).rejects.toThrow(InsufficientCreditsError)
  })

  it('sets callCost and calls next when user has sufficient credits', async () => {
    const req = {
      apiKeyType: 'live',
      user: { credits: new Prisma.Decimal('5.00') },
    } as unknown as Request
    const next = vi.fn() as unknown as NextFunction

    await checkCredits(req, {} as Response, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.callCost?.greaterThan(0)).toBe(true)
  })
})
