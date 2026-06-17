import { PrismaClient } from '@prisma/client'
import { syncUserById } from '../src/services/syncService'

const prisma = new PrismaClient()

async function main() {
  const userOfferId = process.argv[2]
  if (!userOfferId) {
    console.error('Usage: npx ts-node scripts/rematch-offer.ts <user_offer_id> [--force]')
    process.exit(1)
  }

  const userOffer = await prisma.userOffer.findUnique({
    where: { id: userOfferId },
    include: { offer: true },
  })
  if (!userOffer) {
    console.error(`user_offer not found: ${userOfferId}`)
    process.exit(1)
  }
  console.log(`Found user_offer: "${userOffer.offer.title}" for user ${userOffer.user_id}`)

  await prisma.userOffer.delete({ where: { id: userOfferId } })
  console.log(`Deleted user_offer ${userOfferId}`)

  const force = process.argv.includes('--force')
  if (force) {
    await prisma.user.update({ where: { id: userOffer.user_id }, data: { sync_started_at: null } })
    await prisma.notificationLock.deleteMany({ where: { lock_key: { contains: userOffer.user_id } } })
    console.log(`Force mode: cleared sync lock for user ${userOffer.user_id}`)
  }

  const startTime = Date.now()
  console.log(`Syncing user ${userOffer.user_id}...`)
  await syncUserById(userOffer.user_id)
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`Done in ${elapsed}s.`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
