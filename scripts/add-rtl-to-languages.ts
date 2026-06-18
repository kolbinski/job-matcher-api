import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const RTL_CODES = new Set(['ar', 'he'])

interface LangEntry {
  code: string
  name: string
  locale?: string
  gdpr?: string
  best_regards?: string
  present_label?: string
  rtl?: boolean
  [key: string]: unknown
}

async function main() {
  const row = await prisma.settings.findUnique({ where: { key: 'general_settings' } })
  if (!row) {
    console.error('general_settings row not found')
    process.exit(1)
  }

  const parsed = JSON.parse(row.value) as Record<string, unknown>
  const languages = (parsed.languages ?? []) as LangEntry[]

  const updated = languages.map(l => ({
    ...l,
    rtl: RTL_CODES.has(l.code),
  }))

  parsed.languages = updated

  await prisma.settings.update({
    where: { key: 'general_settings' },
    data: { value: JSON.stringify(parsed) },
  })

  console.log(`Updated ${updated.length} language entries with rtl field`)
  updated.forEach(l => console.log(`  ${l.code} → ${l.rtl}`))
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
