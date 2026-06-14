import { prisma } from '../src/lib/prisma'
import { Prisma } from '@prisma/client'

async function main() {
  const offers = await prisma.offer.findMany({
    where: { employment_types: { not: [] as Prisma.InputJsonValue } },
    select: { id: true, employment_types: true },
  })

  const candidates = offers.filter(o => Array.isArray(o.employment_types) && (o.employment_types as unknown[]).length > 0)

  console.log(`Found ${candidates.length} offers with non-empty employment_types`)

  let updatedCount = 0
  let checkedCount = 0

  for (const offer of candidates) {
    const types = offer.employment_types as Array<{ from?: number | null; to?: number | null }>
    const filtered = types.filter(et => (et.from ?? 0) > 0 && (et.to ?? 0) > 0)

    if (filtered.length !== types.length) {
      await prisma.offer.update({
        where: { id: offer.id },
        data: { employment_types: filtered as Prisma.InputJsonValue },
      })
      updatedCount++
    }

    checkedCount++
    if (checkedCount % 100 === 0) {
      console.log(`Progress: ${checkedCount}/${candidates.length} checked, ${updatedCount} updated so far`)
    }
  }

  console.log(`Done. Checked ${checkedCount} offers, updated ${updatedCount}.`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
