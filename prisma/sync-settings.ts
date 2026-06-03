import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Run after every Railway deploy to keep settings rows in sync with code.
// Unlike seed.ts (which skips existing rows), this always applies the latest values.
const SETTINGS = [
  { key: 'call_cost',                value: '0.10' },
  { key: 'cronjob_interval_minutes', value: '15' },
  { key: 'ai_scoring_enabled',       value: 'true' },
  { key: 'cronjob_schedule',         value: '45 6 * * 1-5|0 7-15 * * 1-5' },
  { key: 'work_start_utc',           value: '6' },
  { key: 'work_end_utc',             value: '15' },
  { key: 'work_days',                value: '1-5' },
]

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
