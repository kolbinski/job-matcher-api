import { prisma } from '../src/lib/prisma'

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      subscription: {
        select: {
          plan: { select: { limits: true } },
        },
      },
    },
  })

  let updatedCount = 0

  for (const user of users) {
    const limits = user.subscription?.plan?.limits as Record<string, unknown> | null ?? {}
    const cvMax = typeof limits['max_cv'] === 'number' ? limits['max_cv'] : 0
    const clMax = typeof limits['max_cl'] === 'number' ? limits['max_cl'] : 0

    await prisma.user.update({
      where: { id: user.id },
      data: { cv_counter_max: cvMax, cl_counter_max: clMax },
    })

    updatedCount++
  }

  console.log(`Done. Updated ${updatedCount} users.`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
