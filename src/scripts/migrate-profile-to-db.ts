import fs from 'fs'
import path from 'path'
import { prisma } from '../lib/prisma'

const USER_ID = '7ca43c93-edfb-461f-a67f-0a047fc29b4a'
const PROFILE_PATH = path.resolve(process.cwd(), 'src/data/marek-wisniewski-profile.json')

async function main(): Promise<void> {
  const raw = fs.readFileSync(PROFILE_PATH, 'utf-8')
  const profile = JSON.parse(raw) as object

  const result = await prisma.user.update({
    where: { id: USER_ID },
    data: { profile },
    select: { id: true, email: true },
  })

  console.log(`Profile migrated to DB for user ${result.email} (${result.id})`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
