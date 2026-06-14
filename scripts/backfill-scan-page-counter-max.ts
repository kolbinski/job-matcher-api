import { prisma } from '../src/lib/prisma'

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true },
  })

  let updatedCount = 0

  for (const user of users) {
    const subscription = await prisma.subscription.findFirst({
      where: { user_id: user.id },
      include: { plan: true },
    })

    const limits = subscription?.plan?.limits as { max_scan_page?: number | null } | null
    const maxScanPage = limits?.max_scan_page ?? 0

    await prisma.user.update({
      where: { id: user.id },
      data: { scan_page_counter_max: maxScanPage },
    })

    updatedCount++
    if (updatedCount % 100 === 0) {
      console.log(`Progress: ${updatedCount}/${users.length}`)
    }
  }

  console.log(`Done. Updated ${updatedCount} users.`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
