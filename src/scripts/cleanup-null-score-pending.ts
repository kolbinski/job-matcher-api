import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const result = await prisma.userOffer.deleteMany({
    where: { status: 'pending_apply', claude_score: null },
  })
  console.log(`Deleted ${result.count} rows: status=pending_apply, claude_score=null`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
