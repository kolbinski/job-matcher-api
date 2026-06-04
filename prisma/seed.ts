import { PrismaClient } from '@prisma/client'
import { SETTINGS } from './settings.config'

const prisma = new PrismaClient()

async function main() {
  for (const setting of SETTINGS) {
    await prisma.settings.upsert({
      where:  { key: setting.key },
      update: {},
      create: setting,
    })
  }
  console.log('Seeded settings:', SETTINGS.map(s => s.key).join(', '))
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
