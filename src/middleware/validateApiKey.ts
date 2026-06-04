import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../lib/prisma'
import { InvalidApiKeyError } from '../lib/errors'

export async function validateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const key = req.headers['x-api-key']

  if (!key || typeof key !== 'string') {
    throw new InvalidApiKeyError()
  }

  const user = await prisma.user.findUnique({
    where: { jobmatcher_api_key: key },
  })

  if (!user) {
    throw new InvalidApiKeyError()
  }

  req.user = user
  next()
}
