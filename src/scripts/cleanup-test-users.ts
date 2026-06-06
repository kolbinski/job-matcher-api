import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
dotenv.config()

const prisma = new PrismaClient()

async function main() {
  // Show FK delete rules for tables referencing users
  const fkRules = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; delete_rule: string }>>`
    SELECT tc.table_name, kcu.column_name, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND kcu.table_schema = 'public'
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = 'public'
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'users'
    ORDER BY tc.table_name
  `
  console.log('FK constraints referencing users:')
  for (const row of fkRules) {
    console.log(`  ${row.table_name}.${row.column_name} → users.id  (ON DELETE ${row.delete_rule})`)
  }

  // Find test users
  const testUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { contains: '@jobmatche' } },
        { email: { contains: '@jobmatcl' } },
        { email: { contains: 'stretch-test' } },
        { email: { contains: 'match-test' } },
      ],
    },
    select: { id: true, email: true },
  })

  console.log(`\nFound ${testUsers.length} test users:`)
  for (const u of testUsers) console.log(`  ${u.email}`)

  if (testUsers.length === 0) {
    console.log('Nothing to clean up.')
    return
  }

  const ids = testUsers.map(u => u.id)

  const uoCount = await prisma.userOffer.count({ where: { user_id: { in: ids } } })
  const acCount = await prisma.apiCall.count({ where: { user_id: { in: ids } } })
  const agcCount = await prisma.agentClient.count({ where: { user_id: { in: ids } } })
  console.log(`\nRows to delete: user_offers=${uoCount}, api_calls=${acCount}, agent_clients=${agcCount}`)

  // Delete in FK order
  await prisma.userOffer.deleteMany({ where: { user_id: { in: ids } } })
  await prisma.apiCall.deleteMany({ where: { user_id: { in: ids } } })
  await prisma.agentClient.deleteMany({ where: { user_id: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })

  console.log(`\nDeleted ${testUsers.length} test users and all related rows.`)

  // Post-cleanup duplicate check
  const dups = await prisma.$queryRaw<Array<{ offer_id: string; user_id: string; cnt: bigint }>>`
    SELECT offer_id, user_id, COUNT(*) AS cnt
    FROM user_offers
    GROUP BY offer_id, user_id
    HAVING COUNT(*) > 1
  `
  const totalUserOffers = await prisma.userOffer.count()
  console.log(`\nuser_offers total after cleanup: ${totalUserOffers}`)
  if (dups.length > 0) {
    console.log(`Duplicate (offer_id, user_id) pairs found: ${dups.length}`)
    for (const d of dups.slice(0, 10)) {
      console.log(`  offer_id=${d.offer_id}  user_id=${d.user_id}  count=${d.cnt}`)
    }
  } else {
    console.log('No duplicate (offer_id, user_id) pairs — unique constraint is clean.')
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
