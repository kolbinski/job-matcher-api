import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const NATIVE_LABEL_MAP: Record<string, string> = {
  en: 'native',
  pl: 'ojczysty',
  de: 'Muttersprache',
  fr: 'langue maternelle',
  es: 'nativo',
  it: 'madrelingua',
  pt: 'nativo',
  ru: 'родной',
  uk: 'рідна',
  nl: 'moedertaal',
  sv: 'modersmål',
  no: 'morsmål',
  da: 'modersmål',
  fi: 'äidinkieli',
  cs: 'rodný jazyk',
  sk: 'rodný jazyk',
  hu: 'anyanyelv',
  ro: 'limbă maternă',
  tr: 'anadil',
  ar: 'اللغة الأم',
  he: 'שפת אם',
  zh: '母语',
  ja: '母国語',
  ko: '모국어',
  hi: 'मातृभाषा',
}

interface LangEntry {
  code: string
  name: string
  locale?: string
  gdpr?: string
  best_regards?: string
  present_label?: string
  rtl?: boolean
  native_label?: string
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
    native_label: l.native_label ?? NATIVE_LABEL_MAP[l.code] ?? 'native',
  }))

  parsed.languages = updated

  await prisma.settings.update({
    where: { key: 'general_settings' },
    data: { value: JSON.stringify(parsed) },
  })

  console.log(`Updated ${updated.length} language entries with native_label field`)
  updated.forEach(l => console.log(`  ${l.code} → ${l.native_label}`))
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
