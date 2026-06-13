import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const freePlan = await prisma.plan.findUnique({ where: { name: 'free' } })
  if (!freePlan) {
    console.error('Free plan not found in DB — run seed migration first')
    process.exit(1)
  }

  const usersWithoutSubscription = await prisma.user.findMany({
    where: { subscription: { is: null } },
    select: { id: true },
  })

  if (usersWithoutSubscription.length === 0) {
    console.log('All users already have a subscription row — nothing to do')
    return
  }

  await prisma.subscription.createMany({
    data: usersWithoutSubscription.map(u => ({
      user_id: u.id,
      plan_id: freePlan.id,
      status: 'active',
      stripe_subscription_id: null,
      current_period_start: null,
      current_period_end: null,
    })),
    skipDuplicates: true,
  })

  console.log(`Created ${usersWithoutSubscription.length} Free plan subscription rows`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
