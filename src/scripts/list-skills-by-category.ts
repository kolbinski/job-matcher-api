import { prisma } from '../lib/prisma'

async function main() {
  const categories = await prisma.skillCategory.findMany({
    where: { market: 'IT' },
    include: {
      skills: {
        orderBy: { name: 'asc' }
      }
    },
    orderBy: { sort_order: 'asc' }
  })

  for (const cat of categories) {
    if (cat.skills.length === 0) continue
    const skillNames = cat.skills.map(s => s.name).join(', ')
    console.log(`${cat.name}: ${skillNames}`)
    console.log()
  }

  await prisma.$disconnect()
}

main()
