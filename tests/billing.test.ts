import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import crypto from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../src/lib/prisma'
import { validateApiKey } from '../src/middleware/validateApiKey'
import { InvalidApiKeyError } from '../src/lib/errors'

afterAll(async () => {
  await prisma.$disconnect()
})

describe('validateApiKey', () => {
  let userId = ''
  let apiKey: string

  beforeEach(async () => {
    apiKey = `jm_live_${crypto.randomBytes(16).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `test-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: apiKey,
      },
    })
    userId = user.id
  })

  afterEach(async () => {
    if (userId) await prisma.user.deleteMany({ where: { id: userId } })
  })

  it('attaches user to req for a valid key', async () => {
    const req = { headers: { 'x-api-key': apiKey } } as unknown as Request
    const next = vi.fn() as unknown as NextFunction

    await validateApiKey(req, {} as Response, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.user?.id).toBe(userId)
  })

  it('throws InvalidApiKeyError when X-API-Key header is missing', async () => {
    const req = { headers: {} } as unknown as Request
    await expect(
      validateApiKey(req, {} as Response, vi.fn() as unknown as NextFunction)
    ).rejects.toThrow(InvalidApiKeyError)
  })

  it('throws InvalidApiKeyError for an unknown key', async () => {
    const req = { headers: { 'x-api-key': 'jm_live_unknownkey' } } as unknown as Request
    await expect(
      validateApiKey(req, {} as Response, vi.fn() as unknown as NextFunction)
    ).rejects.toThrow(InvalidApiKeyError)
  })

  it('accepts any key format as long as it exists in the DB', async () => {
    const customKey = `custom_key_${crypto.randomBytes(8).toString('hex')}`
    const user = await prisma.user.create({
      data: {
        email: `custom-${crypto.randomBytes(8).toString('hex')}@jobmatcher-test.invalid`,
        jobmatcher_api_key: customKey,
      },
    })

    const req = { headers: { 'x-api-key': customKey } } as unknown as Request
    const next = vi.fn() as unknown as NextFunction

    await validateApiKey(req, {} as Response, next)

    expect(next).toHaveBeenCalledOnce()

    await prisma.user.delete({ where: { id: user.id } })
  })
})
