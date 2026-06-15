import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
dotenv.config()

const prisma = new PrismaClient()

async function main() {
  const { count: timezoneCount } = await prisma.user.updateMany({
    where: { timezone: null },
    data: { timezone: 'Europe/Warsaw' },
  })
  console.log(`[backfill] Set timezone='Europe/Warsaw' for ${timezoneCount} users`)

  const { count: currencyCount } = await prisma.user.updateMany({
    where: { preferred_currency: null },
    data: { preferred_currency: 'PLN' },
  })
  console.log(`[backfill] Set preferred_currency='PLN' for ${currencyCount} users`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
