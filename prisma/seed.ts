import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const SEED_SETTINGS = [
  { key: 'call_cost', value: '0.10' },
  { key: 'cronjob_interval_minutes', value: '15' },
  { key: 'cronjob_schedule', value: '45 7 * * 1-5|0 8-16 * * 1-5' },
  { key: 'ai_scoring_enabled', value: 'true' },
]

async function main() {
  for (const setting of SEED_SETTINGS) {
    await prisma.settings.upsert({
      where: { key: setting.key },
      update: {},
      create: setting,
    })
  }
  console.log('Seeded settings:', SEED_SETTINGS.map((s) => s.key).join(', '))
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
