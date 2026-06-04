import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { fetchPage, NormalizedOffer } from '../services/offerScraper'
import { env } from '../lib/env'

const BATCH_SIZE = 500

export const PAGE_DELAY_MIN_MS = env.NODE_ENV === 'test' ? 0 : 20_000
export const PAGE_DELAY_MAX_MS = env.NODE_ENV === 'test' ? 0 : 60_000

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
): Promise<{ inserted: number; updated: number; insertedSlugs: string[] }> {
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

  return { inserted: toInsert.length, updated: toUpdate.length, insertedSlugs: toInsert.map(o => o.slug) }
}

function logSkillBreakdown(skillCounts: Map<string, number>): void {
  const top = [...skillCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([skill, n]) => `${skill}: ${n}`)
    .join(', ')
  console.log(`[offerSync] Top skills: ${top}`)
}

export async function syncOffers(cleanupEnabled = true): Promise<{ fetched: number; inserted: number; updated: number; deleted: number }> {
  const fetchedAt = new Date()

  // Load max_pages and existing slugs in parallel
  const [maxPagesRow, existingSlugsRaw] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'max_pages' } }),
    prisma.offer.findMany({ select: { slug: true } }),
  ])
  const maxPages = parseInt(maxPagesRow?.value ?? '3', 10)
  const existingSlugs = new Set(existingSlugsRaw.map(o => o.slug))

  const skillCounts = new Map<string, number>()
  let totalFetched = 0
  let totalInserted = 0
  let totalUpdated = 0
  let from = 0
  let pageNum = 0

  while (true) {
    if (pageNum >= maxPages) {
      console.log(`[offerSync] Reached max_pages limit (${maxPages}) — stopping`)
      break
    }

    if (pageNum > 0 && PAGE_DELAY_MAX_MS > 0) {
      const delay = Math.floor(Math.random() * (PAGE_DELAY_MAX_MS - PAGE_DELAY_MIN_MS + 1)) + PAGE_DELAY_MIN_MS
      console.log(`[offerScraper] Waiting ${Math.round(delay / 1000)}s before next page...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }

    const pageStart = Date.now()
    const { offers, nextCursor } = await fetchPage(from)

    if (offers.length === 0) break

    const { inserted, updated, insertedSlugs } = await upsertPage(offers, existingSlugs, fetchedAt)
    for (const slug of insertedSlugs) existingSlugs.add(slug)
    const pageMs = Date.now() - pageStart

    for (const o of offers) {
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

  if (!cleanupEnabled) {
    console.log('[offerSync] Outside working hours — skipping offer cleanup')
    console.log(`[offerSync] Sync complete: fetched ${totalFetched}, inserted ${totalInserted}, updated ${totalUpdated}, deleted 0`)
    logSkillBreakdown(skillCounts)
    return { fetched: totalFetched, inserted: totalInserted, updated: totalUpdated, deleted: 0 }
  }

  // Offers not seen in this run retain their pre-sync fetched_at (< fetchedAt) or are null.
  // Both cases mean they were absent from the current fetch — safe to delete.
  const deleted = await prisma.offer.deleteMany({
    where: {
      OR: [
        { fetched_at: null },
        { fetched_at: { lt: fetchedAt } },
      ],
    },
  })

  console.log(
    `[offerSync] Sync complete: fetched ${totalFetched}, inserted ${totalInserted}, updated ${totalUpdated}, deleted ${deleted.count}`,
  )
  logSkillBreakdown(skillCounts)

  return { fetched: totalFetched, inserted: totalInserted, updated: totalUpdated, deleted: deleted.count }
}
