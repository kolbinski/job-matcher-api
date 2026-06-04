import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const SEED_SETTINGS = [
  { key: 'cronjob_interval_minutes', value: '15' },
  { key: 'cronjob_schedule', value: '45 6 * * 1-5|0 7-15 * * 1-5' },
  { key: 'work_start_utc',  value: '6' },
  { key: 'work_end_utc',    value: '15' },
  { key: 'work_days',       value: '1-5' },
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
