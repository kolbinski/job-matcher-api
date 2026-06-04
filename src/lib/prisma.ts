import { PrismaClient } from '@prisma/client'

declare global {
  // Prevent multiple PrismaClient instances in development (tsx watch reloads)
  var __prisma: PrismaClient | undefined
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma
}
