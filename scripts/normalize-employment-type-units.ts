import { prisma } from '../src/lib/prisma'
import { Prisma } from '@prisma/client'

async function main() {
  const offers = await prisma.offer.findMany({
    where: { employment_types: { not: undefined } },
    select: { id: true, employment_types: true },
  })

  const toUpdate = offers.filter(o => {
    const types = o.employment_types
    return Array.isArray(types) && types.length > 0
  })

  console.log(`Found ${toUpdate.length} offers with employment_types to normalize`)

  let updatedCount = 0

  for (const offer of toUpdate) {
    const types = offer.employment_types as Array<Record<string, unknown>>
    const normalized = types.map(e => ({
      ...e,
      unit: typeof e.unit === 'string' ? e.unit.toLowerCase() : e.unit,
    })) as Prisma.InputJsonValue

    await prisma.offer.update({
      where: { id: offer.id },
      data: { employment_types: normalized },
    })

    updatedCount++
    if (updatedCount % 100 === 0) {
      console.log(`Progress: ${updatedCount}/${toUpdate.length}`)
    }
  }

  console.log(`Done. Updated ${updatedCount} offers.`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
