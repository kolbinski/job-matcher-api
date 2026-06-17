import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const LOCALE_MAP: Record<string, string> = {
  en: 'en-US',
  pl: 'pl-PL',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  pt: 'pt-PT',
  ru: 'ru-RU',
  uk: 'uk-UA',
  nl: 'nl-NL',
  sv: 'sv-SE',
  no: 'nb-NO',
  da: 'da-DK',
  fi: 'fi-FI',
  cs: 'cs-CZ',
  sk: 'sk-SK',
  hu: 'hu-HU',
  ro: 'ro-RO',
  tr: 'tr-TR',
  ar: 'ar-SA',
  he: 'he-IL',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  hi: 'hi-IN',
}

interface LangEntry {
  code: string
  name: string
  locale?: string
  gdpr?: string
  best_regards?: string
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
    locale: l.locale ?? LOCALE_MAP[l.code] ?? 'en-US',
  }))

  parsed.languages = updated

  await prisma.settings.update({
    where: { key: 'general_settings' },
    data: { value: JSON.stringify(parsed) },
  })

  console.log(`Updated ${updated.length} language entries with locale field`)
  updated.forEach(l => console.log(`  ${l.code} → ${l.locale}`))
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
