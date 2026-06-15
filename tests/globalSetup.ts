import dotenv from 'dotenv'

dotenv.config()

export async function teardown() {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  try {
    const testUsers = await prisma.user.findMany({
      where: { email: { endsWith: '@jobmatcher-test.invalid' } },
      select: { id: true },
    })
    if (testUsers.length === 0) return

    const ids = testUsers.map(u => u.id)

    await prisma.userOfferStatus.deleteMany({ where: { user_offer: { user_id: { in: ids } } } })
    await prisma.userOffer.deleteMany({ where: { user_id: { in: ids } } })
    await prisma.pushToken.deleteMany({ where: { user_id: { in: ids } } })
    await prisma.agentClient.deleteMany({ where: { user_id: { in: ids } } })
    await prisma.feedback.deleteMany({ where: { user_id: { in: ids } } })
    await prisma.userSync.deleteMany({ where: { user_id: { in: ids } } })
    await prisma.apiCall.deleteMany({ where: { user_id: { in: ids } } })
    await prisma.subscription.deleteMany({ where: { user_id: { in: ids } } })

    const { count } = await prisma.user.deleteMany({ where: { id: { in: ids } } })
    console.log(`[globalTeardown] Deleted ${count} test user(s)`)
  } finally {
    await prisma.$disconnect()
  }
}
