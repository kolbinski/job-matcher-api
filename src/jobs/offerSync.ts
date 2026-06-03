import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { fetchOffers, NormalizedOffer } from '../services/offerScraper'

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

function logSkillBreakdown(offers: NormalizedOffer[]): void {
  const counts = new Map<string, number>()
  for (const offer of offers) {
    const primary = offer.required_skills[0]
    if (primary) counts.set(primary, (counts.get(primary) ?? 0) + 1)
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([skill, n]) => `${skill}: ${n}`)
    .join(', ')
  console.log(`[offerSync] Top skills: ${top}`)
}

export async function syncOffers(): Promise<{ fetched: number; inserted: number; updated: number; deleted: number }> {
  const raw = await fetchOffers()

  // Rule A-4: never delete from DB when fetch returns nothing (API error / rate limit)
  if (raw.length === 0) {
    console.warn('[offerSync] API returned 0 offers — skipping deletion')
    return { fetched: 0, inserted: 0, updated: 0, deleted: 0 }
  }

  const fetchedAt = new Date()

  // One query to split inserts from updates
  const existingSlugs = new Set(
    (await prisma.offer.findMany({ select: { slug: true } })).map(o => o.slug)
  )

  const toInsert = raw.filter(o => !existingSlugs.has(o.slug))
  const toUpdate = raw.filter(o => existingSlugs.has(o.slug))

  // Bulk insert in batches of 500
  for (const batch of chunk(toInsert, BATCH_SIZE)) {
    await prisma.offer.createMany({
      data: batch.map(o => toUpsertData(o, fetchedAt)),
      skipDuplicates: true,
    })
  }

  // Update existing offers sequentially — no transaction wrapper so the single
  // pooled connection is released between each query and health checks can run.
  let updatedCount = 0
  for (const batch of chunk(toUpdate, BATCH_SIZE)) {
    for (const offer of batch) {
      await prisma.offer.update({
        where: { slug: offer.slug },
        data: toUpsertData(offer, fetchedAt),
      })
    }
    updatedCount += batch.length
    console.log(`[offerSync] Updated ${updatedCount}/${toUpdate.length}...`)
  }

  const fetchedSlugs = raw.map(o => o.slug)
  const deleted = await prisma.offer.deleteMany({
    where: { slug: { notIn: fetchedSlugs } },
  })

  console.log(
    `[offerSync] Sync complete: fetched ${raw.length}, inserted ${toInsert.length}, updated ${toUpdate.length}, deleted ${deleted.count}`,
  )
  logSkillBreakdown(raw)

  return { fetched: raw.length, inserted: toInsert.length, updated: toUpdate.length, deleted: deleted.count }
}
