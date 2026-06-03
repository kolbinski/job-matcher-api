import type { Prisma, User } from '@prisma/client'

declare global {
  namespace Express {
    interface Request {
      user?: User
      apiKeyType?: 'live' | 'test'
      callCost?: Prisma.Decimal
    }
  }
}

export {}
