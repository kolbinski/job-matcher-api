import { prisma } from '../src/lib/prisma'

async function main() {
  const users = await prisma.user.findMany({ select: { id: true } })
  let updated = 0

  for (const user of users) {
    const [statusCount, subscription] = await Promise.all([
      prisma.userOfferStatus.count({ where: { user_offer: { user_id: user.id } } }),
      prisma.subscription.findUnique({
        where: { user_id: user.id },
        include: { plan: true },
      }),
    ])

    const maxStatusChange = subscription?.plan?.max_status_change ?? null

    await prisma.user.update({
      where: { id: user.id },
      data: {
        status_change_counter: statusCount,
        status_change_counter_max: maxStatusChange,
      },
    })

    updated++
    if (updated % 100 === 0) console.log(`Progress: ${updated}/${users.length}`)
  }

  console.log(`Done. Updated ${updated} users.`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
