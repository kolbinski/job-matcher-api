import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import { calculateUserOfferSalary } from '../lib/salaryCalculator'
dotenv.config()

const prisma = new PrismaClient()

async function main() {
  const exchangeRatesSetting = await prisma.settings.findUnique({ where: { key: 'exchange_rates' } })
  const exchangeRates: Record<string, number> = exchangeRatesSetting
    ? (JSON.parse(exchangeRatesSetting.value) as Record<string, number>)
    : {}

  const users = await prisma.user.findMany({
    select: {
      id: true,
      preferred_currency: true,
      profile: true,
    },
  })
  console.log(`[backfill] Processing ${users.length} users`)

  let totalUpdated = 0

  for (const user of users) {
    const preferredCurrency = user.preferred_currency ?? 'USD'
    const raw = user.profile as { preferences?: { salary?: Array<{ type: string; currency: string; min: number }> } } | null
    const salaryPrefs = (raw?.preferences?.salary ?? []).filter(
      p => p.type != null && p.currency != null && p.min != null,
    )

    const BATCH = 100
    let skip = 0

    while (true) {
      const offers = await prisma.userOffer.findMany({
        where: { user_id: user.id },
        select: { id: true, offer: { select: { employment_types: true } } },
        take: BATCH,
        skip,
      })
      if (offers.length === 0) break

      for (const uo of offers) {
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
        totalUpdated++
      }

      console.log(`[backfill] user ${user.id}: processed ${skip + offers.length} offers`)
      skip += BATCH
      if (offers.length < BATCH) break
    }
  }

  console.log(`[backfill] Done — updated ${totalUpdated} user_offers`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
