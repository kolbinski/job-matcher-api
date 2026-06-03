import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { fetchPage, NormalizedOffer, PAGE_SIZE } from '../services/offerScraper'

const BATCH_SIZE = 500

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function toUpsertData(offer: NormalizedOffer, fetchedAt: Date) {
  return {
    slug: offer.slug,
    source: offer.source,
    title: offer.title,
    company_name: offer.company_name,
    company_logo_url: offer.company_logo_url,
    experience_level: offer.experience_level,
    workplace_type: offer.workplace_type,
    working_time: offer.working_time,
    remote_interview: offer.remote_interview,
    required_skills: offer.required_skills,
    nice_to_have_skills: offer.nice_to_have_skills,
    employment_types: offer.employment_types as Prisma.InputJsonValue,
    multilocation:
      offer.multilocation !== null
        ? (offer.multilocation as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    city: offer.city,
    street: offer.street,
    latitude: offer.latitude,
    longitude: offer.longitude,
    category_id: offer.category_id,
    open_to_hire_ukrainians: offer.open_to_hire_ukrainians,
    languages: offer.languages,
    url: offer.url,
    published_at: offer.published_at,
    fetched_at: fetchedAt,
  }
}

async function upsertPage(
  offers: NormalizedOffer[],
  existingSlugs: Set<string>,
  fetchedAt: Date,
): Promise<{ inserted: number; updated: number }> {
  const toInsert = offers.filter(o => !existingSlugs.has(o.slug))
  const toUpdate = offers.filter(o => existingSlugs.has(o.slug))

  for (const batch of chunk(toInsert, BATCH_SIZE)) {
    await prisma.offer.createMany({
      data: batch.map(o => toUpsertData(o, fetchedAt)),
      skipDuplicates: true,
    })
  }

  for (const offer of toUpdate) {
    await prisma.offer.update({
      where: { slug: offer.slug },
      data: toUpsertData(offer, fetchedAt),
    })
  }

  // Newly inserted slugs are now in DB — add them to the set for later pages
  for (const o of toInsert) existingSlugs.add(o.slug)

  return { inserted: toInsert.length, updated: toUpdate.length }
}

function logSkillBreakdown(slugCounts: Map<string, number>): void {
  const top = [...slugCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([skill, n]) => `${skill}: ${n}`)
    .join(', ')
  console.log(`[offerSync] Top skills: ${top}`)
}

export async function syncOffers(): Promise<{ fetched: number; inserted: number; updated: number; deleted: number }> {
  const fetchedAt = new Date()

  // Load existing slugs once — upsertPage keeps it up to date as pages are inserted
  const existingSlugs = new Set(
    (await prisma.offer.findMany({ select: { slug: true } })).map(o => o.slug)
  )

  const allFetchedSlugs: string[] = []
  const skillCounts = new Map<string, number>()
  let totalFetched = 0
  let totalInserted = 0
  let totalUpdated = 0
  let from = 0
  let pageNum = 0

  while (true) {
    if (pageNum > 0) {
      const delay = Math.floor(Math.random() * (60_000 - 20_000 + 1)) + 20_000
      console.log(`[offerScraper] Waiting ${Math.round(delay / 1000)}s before next page...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }

    const pageStart = Date.now()
    const { offers, nextCursor } = await fetchPage(from)

    if (offers.length === 0) break

    const { inserted, updated } = await upsertPage(offers, existingSlugs, fetchedAt)
    const pageMs = Date.now() - pageStart

    for (const o of offers) {
      allFetchedSlugs.push(o.slug)
      const primary = o.required_skills[0]
      if (primary) skillCounts.set(primary, (skillCounts.get(primary) ?? 0) + 1)
    }

    totalFetched += offers.length
    totalInserted += inserted
    totalUpdated += updated
    pageNum++

    console.log(
      `[offerScraper] Page ${pageNum}: fetched ${offers.length} offers in ${pageMs}ms (total so far: ${totalFetched}, upserted: ${inserted + updated})`,
    )

    if (nextCursor === null) break
    from = nextCursor
  }

  // Rule A-4: never delete when nothing was fetched (API error / rate limit)
  if (totalFetched === 0) {
    console.warn('[offerSync] No offers fetched — skipping deletion')
    return { fetched: 0, inserted: 0, updated: 0, deleted: 0 }
  }

  const deleted = await prisma.offer.deleteMany({
    where: { slug: { notIn: allFetchedSlugs } },
  })

  console.log(
    `[offerSync] Sync complete: fetched ${totalFetched}, inserted ${totalInserted}, updated ${totalUpdated}, deleted ${deleted.count}`,
  )
  logSkillBreakdown(skillCounts)

  return { fetched: totalFetched, inserted: totalInserted, updated: totalUpdated, deleted: deleted.count }
}
