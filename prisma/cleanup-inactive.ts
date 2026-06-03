import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const result = await prisma.offer.deleteMany({ where: { is_active: false } })
  console.log(`Deleted ${result.count} inactive offers`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
