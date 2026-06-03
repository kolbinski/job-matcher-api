import type { Request, Response, NextFunction } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { InsufficientCreditsError } from '../lib/errors'

export async function checkCredits(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.apiKeyType === 'test') {
    req.callCost = new Prisma.Decimal(0)
    return next()
  }

  const user = req.user
  if (!user) throw new Error('validateApiKey must run before checkCredits')

  const setting = await prisma.settings.findUnique({ where: { key: 'call_cost' } })
  if (!setting) throw new Error('settings.call_cost not found')

  const callCost = new Prisma.Decimal(setting.value)

  if (user.credits.lessThan(callCost)) {
    throw new InsufficientCreditsError()
  }

  req.callCost = callCost
  next()
}
