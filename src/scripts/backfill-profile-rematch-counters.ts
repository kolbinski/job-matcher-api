import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
dotenv.config()

const prisma = new PrismaClient()

async function main() {
  const users = await prisma.user.findMany({
    include: {
      subscription: { include: { plan: { select: { limits: true } } } },
    },
  })

  let updated = 0
  for (const user of users) {
    const limits = user.subscription?.plan?.limits as Record<string, unknown> | null | undefined
    const max = Number(limits?.['profile_relevant_change_max'] ?? 0)
    await prisma.user.update({
      where: { id: user.id },
      data: { profile_relevant_change_counter_max: max },
    })
    updated++
  }

  console.log(`[backfill] Updated profile_relevant_change_counter_max for ${updated} users`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
