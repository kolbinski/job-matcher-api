// One-time backfill: recompute salary_contract_delta / salary_permanent_delta /
// salary_currency for user_offers that predate the salary refactor (both deltas NULL).
//
//   npx ts-node scripts/backfill-salary-deltas.ts
//
// Load .env before importing src/ (src/lib/env validates process.env at import time).
import 'dotenv/config'
import { prisma } from '../src/lib/prisma'
import { calculateUserOfferSalary } from '../src/lib/salaryCalculator'

const BATCH = 500

interface UserPrefs {
  preferredCurrency: string
  salaryPrefs: Array<{ type: string; currency: string; min: number; unit?: string }>
}

async function main(): Promise<void> {
  const exchangeRatesSetting = await prisma.settings.findUnique({ where: { key: 'exchange_rates' } })
  const exchangeRates: Record<string, number> = exchangeRatesSetting
    ? (JSON.parse(exchangeRatesSetting.value) as Record<string, number>)
    : {}

  const where = {
    status: { in: ['pending_apply', 'ai_rejected'] },
    salary_contract_delta: null,
    salary_permanent_delta: null,
  } as const

  const total = await prisma.userOffer.count({ where })
  console.log(`[backfill] ${total} user_offers to process`)

  // Cache per-user prefs (currency + salary prefs) so we fetch each profile once.
  const userCache = new Map<string, UserPrefs>()
  async function getUserPrefs(userId: string): Promise<UserPrefs> {
    const cached = userCache.get(userId)
    if (cached) return cached
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferred_currency: true, profile: true },
    })
    const raw = u?.profile as
      | { preferences?: { salary?: Array<{ type: string; currency: string; min: number; unit?: string }> } }
      | null
    const salaryPrefs = (raw?.preferences?.salary ?? [])
      .filter(p => p.type != null && p.currency != null && p.min != null)
      .map(p => ({ type: p.type, currency: p.currency, min: p.min, unit: p.unit }))
    const prefs: UserPrefs = { preferredCurrency: u?.preferred_currency ?? 'USD', salaryPrefs }
    userCache.set(userId, prefs)
    return prefs
  }

  let processed = 0
  let updated = 0
  let cursor: string | undefined

  // Cursor pagination by id: each row in the original NULL-delta set is visited once,
  // even if recompute leaves it NULL (no contract/permanent entry) — avoids re-querying
  // the shrinking WHERE set in a loop that would never terminate on those rows.
  while (true) {
    const rows = await prisma.userOffer.findMany({
      where,
      select: { id: true, user_id: true, offer: { select: { employment_types: true } } },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (rows.length === 0) break
    cursor = rows[rows.length - 1].id

    for (const uo of rows) {
      const { preferredCurrency, salaryPrefs } = await getUserPrefs(uo.user_id)
      const result = calculateUserOfferSalary(
        Array.isArray(uo.offer.employment_types) ? uo.offer.employment_types : [],
        preferredCurrency,
        salaryPrefs,
        exchangeRates,
      )
      await prisma.userOffer.update({
        where: { id: uo.id },
        data: {
          salary_currency: result?.salary_currency ?? null,
          salary_contract_delta: result?.contract?.delta ?? null,
          salary_permanent_delta: result?.permanent?.delta ?? null,
        },
      })
      processed++
      if (result?.contract || result?.permanent) updated++
      if (processed % 100 === 0) console.log(`[backfill] processed ${processed}/${total}, updated ${updated}`)
    }
  }

  console.log(`[backfill] processed ${processed}/${total}, updated ${updated}`)
  console.log('[backfill] Done.')
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
