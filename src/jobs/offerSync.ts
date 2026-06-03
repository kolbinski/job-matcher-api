import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { fetchOffersFromApify, NormalizedOffer } from '../services/apifyScraper'

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
    is_active: true,
  }
}

export async function syncOffers(): Promise<{ upserted: number; deactivated: number }> {
  const offers = await fetchOffersFromApify()

  // Guard: empty response means Apify was rate-limited or the actor failed silently.
  // Never deactivate all offers on an empty fetch (RULE A-4).
  if (offers.length === 0) {
    console.warn('[offerSync] Apify returned 0 offers — skipping deactivation')
    return { upserted: 0, deactivated: 0 }
  }

  const fetchedAt = new Date()

  for (const offer of offers) {
    const data = toUpsertData(offer, fetchedAt)
    await prisma.offer.upsert({
      where: { slug: offer.slug },
      create: data,
      update: data,
    })
  }

  const fetchedSlugs = offers.map(o => o.slug)

  const deactivated = await prisma.offer.updateMany({
    where: { slug: { notIn: fetchedSlugs }, is_active: true },
    data: { is_active: false },
  })

  console.log(`[offerSync] Upserted ${offers.length} offers, deactivated ${deactivated.count}`)
  return { upserted: offers.length, deactivated: deactivated.count }
}
