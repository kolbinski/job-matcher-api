import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const PRESENT_LABEL_MAP: Record<string, string> = {
  en: 'present',
  pl: 'obecnie',
  de: 'heute',
  fr: 'présent',
  es: 'actualidad',
  it: 'presente',
  pt: 'presente',
  ru: 'н.в.',
  uk: 'до сьогодні',
  nl: 'heden',
  sv: 'nu',
  no: 'nå',
  da: 'nu',
  fi: 'nykyään',
  cs: 'současnost',
  sk: 'súčasnosť',
  hu: 'jelen',
  ro: 'prezent',
  tr: 'günümüz',
  ar: 'الحاضر',
  he: 'היום',
  zh: '至今',
  ja: '現在',
  ko: '현재',
  hi: 'वर्तमान',
}

interface LangEntry {
  code: string
  name: string
  locale?: string
  gdpr?: string
  best_regards?: string
  present_label?: string
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
    present_label: l.present_label ?? PRESENT_LABEL_MAP[l.code] ?? 'present',
  }))

  parsed.languages = updated

  await prisma.settings.update({
    where: { key: 'general_settings' },
    data: { value: JSON.stringify(parsed) },
  })

  console.log(`Updated ${updated.length} language entries with present_label field`)
  updated.forEach(l => console.log(`  ${l.code} → ${l.present_label}`))
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
