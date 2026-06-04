import { PrismaClient } from '@prisma/client'
import { SETTINGS } from './settings.config'

const prisma = new PrismaClient()

// Run after every Railway deploy to keep settings rows in sync with code.
// Unlike seed.ts (which skips existing rows), this always applies the latest values.
async function main() {
  for (const setting of SETTINGS) {
    await prisma.settings.upsert({
      where:  { key: setting.key },
      update: { value: setting.value },
      create: setting,
    })
    console.log(`  ${setting.key} = ${setting.value}`)
  }
  console.log(`\nSync complete — ${SETTINGS.length} settings applied.`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
