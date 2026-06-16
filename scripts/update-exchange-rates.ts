import { updateExchangeRates } from '../src/lib/exchangeRates'
import { prisma } from '../src/lib/prisma'

// Force update by clearing the staleness timestamp before calling
async function main() {
  await prisma.settings.deleteMany({ where: { key: 'exchange_rates_updated_at' } })
  await updateExchangeRates()
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
