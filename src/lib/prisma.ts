import { PrismaClient } from '@prisma/client'

declare global {
  // Prevent multiple PrismaClient instances in development (tsx watch reloads)
  var __prisma: PrismaClient | undefined
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    transactionOptions: {
      timeout: 120_000,
    },
    datasources: {
      db: {
        url: `${process.env.DATABASE_URL ?? ''}?connection_limit=10&pool_timeout=30`,
      },
    },
  })

if (process.env.NODE_ENV === 'development') {
  global.__prisma = prisma
}
