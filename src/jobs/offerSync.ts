import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { fetchPage, NormalizedOffer } from '../services/offerScraper';
import { fetchNfjPage } from '../services/nfjScraper';
import { env } from '../lib/env';

const BATCH_SIZE = 500;

export const PAGE_DELAY_MIN_MS = env.NODE_ENV === 'test' ? 0 : 20_000;
export const PAGE_DELAY_MAX_MS = env.NODE_ENV === 'test' ? 0 : 60_000;
export const NFJ_DELAY_MIN_MS = env.NODE_ENV === 'test' ? 0 : 30_000;
export const NFJ_DELAY_MAX_MS = env.NODE_ENV === 'test' ? 0 : 60_000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
    employment_types:
      offer.employment_types as unknown as Prisma.InputJsonValue,
    multilocation:
      offer.multilocation !== null
        ? (offer.multilocation as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    city: offer.city,
    street: offer.street,
    latitude: offer.latitude,
    longitude: offer.longitude,
    open_to_hire_ukrainians: offer.open_to_hire_ukrainians,
    languages: offer.languages,
    url: offer.url,
    published_at: offer.published_at,
    expired_at: offer.expired_at,
    fetched_at: fetchedAt,
    is_active: true,
  };
}

async function upsertPage(
  offers: NormalizedOffer[],
  fetchedAt: Date,
): Promise<{ inserted: number; updated: number }> {
  let totalInserted = 0;
  let totalUpdated = 0;

  for (const batch of chunk(offers, BATCH_SIZE)) {
    const existingSlugs = new Set(
      await prisma.offer
        .findMany({ where: { slug: { in: batch.map(o => o.slug) } }, select: { slug: true } })
        .then(rows => rows.map(r => r.slug)),
    );
    const newCount = batch.filter(o => !existingSlugs.has(o.slug)).length;
    const updateCount = batch.length - newCount;
    totalInserted += newCount;
    totalUpdated += updateCount;
    console.log(`[offerSync] Batch: ${newCount} new inserts, ${updateCount} updates (${batch.length} total)`);

    for (const offer of batch) {
      const data = toUpsertData(offer, fetchedAt);
      await prisma.offer.upsert({
        where: { slug: offer.slug },
        create: data,
        update: data,
      });

      // Upsert each offer skill into the skills table so newly-seen skills get
      // picked up by the categorizeSkills cron. update:{} preserves existing data
      // (name + category_id + was_categorized) on skills we've already classified.
      const offerSkills = [
        ...new Set([...offer.required_skills, ...offer.nice_to_have_skills]),
      ].filter(Boolean);
      await Promise.all(
        offerSkills.map(skill =>
          prisma.skill.upsert({
            where: { name: skill },
            create: { name: skill, was_categorized: false },
            update: {},
          }),
        ),
      );
    }
  }

  return { inserted: totalInserted, updated: totalUpdated };
}

async function resetProfileSyncedAt(page: number, upsertCount: number): Promise<void> {
  if (upsertCount === 0) return;
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);
  const { count } = await prisma.user.updateMany({
    where: {
      profile_ready: true,
      OR: [
        { profile_synced_at: { not: null } },
        { sync_started_at: { not: null, lt: staleThreshold } },
      ],
    },
    data: { profile_synced_at: null },
  });
  console.log(`[offerSync] Page ${page}: ${upsertCount} new offers — reset profile_synced_at for ${count} users`);
}

function logSkillBreakdown(skillCounts: Map<string, number>): void {
  const top = [...skillCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([skill, n]) => `${skill}: ${n}`)
    .join(', ');
  console.log(`[offerSync] Top skills: ${top}`);
}

type SourceSyncResult = {
  fetched: number;
  inserted: number;
  updated: number;
  skillCounts: Map<string, number>;
  hitPageLimit: boolean;
};

async function syncJustJoin(
  fetchedAt: Date,
  maxPages: number,
): Promise<SourceSyncResult> {
  const skillCounts = new Map<string, number>();
  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let from = 0;
  let pageNum = 0;
  let hitPageLimit = false;

  while (true) {
    if (pageNum >= maxPages) {
      console.log(
        `[offerSync][justjoin] Reached max_pages limit (${maxPages}) — stopping`,
      );
      hitPageLimit = true;
      break;
    }

    if (pageNum > 0 && PAGE_DELAY_MAX_MS > 0) {
      const delay =
        Math.floor(
          Math.random() * (PAGE_DELAY_MAX_MS - PAGE_DELAY_MIN_MS + 1),
        ) + PAGE_DELAY_MIN_MS;
      console.log(
        `[offerSync][justjoin] Waiting ${Math.round(delay / 1000)}s before next page...`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const pageStart = Date.now();
    const { offers, nextCursor } = await fetchPage(from);

    if (offers.length === 0) break;

    const { inserted, updated } = await upsertPage(offers, fetchedAt);
    const pageMs = Date.now() - pageStart;

    for (const o of offers) {
      for (const skill of o.required_skills) {
        skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
      }
    }

    totalFetched += offers.length;
    totalInserted += inserted;
    totalUpdated += updated;
    pageNum++;

    console.log(
      `[offerSync][justjoin] Page ${pageNum}: ${inserted} new inserts, ${updated} updates (${offers.length} total fetched) in ${pageMs}ms`,
    );
    if (inserted > 0) {
      await prisma.offerFetch.create({
        data: { source: 'justjoin', new_inserts_count: inserted, fetched_at: fetchedAt },
      });
    }
    await resetProfileSyncedAt(pageNum, inserted);

    if (nextCursor === null) break;
    from = nextCursor;
  }

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skillCounts,
    hitPageLimit,
  };
}

async function syncNfj(
  fetchedAt: Date,
  maxPages: number,
): Promise<SourceSyncResult> {
  const skillCounts = new Map<string, number>();
  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let hitPageLimit = false;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    if (pageNum > 1 && NFJ_DELAY_MAX_MS > 0) {
      const delay =
        Math.floor(Math.random() * (NFJ_DELAY_MAX_MS - NFJ_DELAY_MIN_MS + 1)) +
        NFJ_DELAY_MIN_MS;
      console.log(
        `[offerSync][nofluffjobs] Waiting ${Math.round(delay / 1000)}s before next page...`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const pageStart = Date.now();
    const { offers, rawCount } = await fetchNfjPage(pageNum);
    console.log(`[offerSync][nofluffjobs] Page ${pageNum}: API returned ${rawCount} raw offers`);

    if (offers.length === 0) break;

    const { inserted, updated } = await upsertPage(offers, fetchedAt);
    const pageMs = Date.now() - pageStart;

    for (const o of offers) {
      for (const skill of o.required_skills) {
        skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
      }
    }

    totalFetched += offers.length;
    totalInserted += inserted;
    totalUpdated += updated;

    console.log(
      `[offerSync][nofluffjobs] Page ${pageNum}: ${inserted} new inserts, ${updated} updates (${offers.length} total fetched) in ${pageMs}ms`,
    );
    if (inserted > 0) {
      await prisma.offerFetch.create({
        data: { source: 'nofluffjobs', new_inserts_count: inserted, fetched_at: fetchedAt },
      });
    }
    await resetProfileSyncedAt(pageNum, inserted);

    if (pageNum === maxPages) {
      console.log(
        `[offerSync][nofluffjobs] Reached max_pages limit (${maxPages}) — stopping`,
      );
      hitPageLimit = true;
    }
  }

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    skillCounts,
    hitPageLimit,
  };
}

export async function syncOffers(cleanupEnabled = true): Promise<{
  fetched: number;
  inserted: number;
  updated: number;
  deleted: number;
}> {
  const fetchedAt = new Date();

  await prisma.offer.updateMany({
    where: { expired_at: { lt: new Date() } },
    data: { is_active: false },
  });
  console.log('[offerSync] Marked expired offers as inactive');

  const [maxPagesRow, nfjMaxPagesRow] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'justjoin_max_pages' } }),
    prisma.settings.findUnique({ where: { key: 'nfj_max_pages' } }),
  ]);
  const maxPages = parseInt(maxPagesRow?.value ?? '3', 10);
  const nfjMaxPages = parseInt(nfjMaxPagesRow?.value ?? '3', 10);

  console.log(
    `[offerSync] Starting sync — justjoin max_pages=${maxPages}, nfj max_pages=${nfjMaxPages}`,
  );

  const [jjResult, nfjResult] = await Promise.all([
    syncJustJoin(fetchedAt, maxPages),
    syncNfj(fetchedAt, nfjMaxPages),
  ]);

  const totalFetched = jjResult.fetched + nfjResult.fetched;
  const totalInserted = jjResult.inserted + nfjResult.inserted;
  const totalUpdated = jjResult.updated + nfjResult.updated;
  const hitPageLimit = jjResult.hitPageLimit && nfjResult.hitPageLimit;

  const skillCounts = jjResult.skillCounts;
  for (const [skill, count] of nfjResult.skillCounts) {
    skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + count);
  }

  console.log(
    `[offerSync] hitPageLimit=${hitPageLimit}, cleanupEnabled=${cleanupEnabled}, totalFetched=${totalFetched}`,
  );

  if (totalFetched === 0) {
    console.warn('[offerSync] No offers fetched — skipping deletion');
    return { fetched: 0, inserted: 0, updated: 0, deleted: 0 };
  }

  if (hitPageLimit) {
    console.warn(
      `[offerSync] Partial scrape — skipping deletion to protect existing offers`,
    );
    console.log(
      `[offerSync] Sync complete: fetched ${totalFetched}, inserted ${totalInserted}, updated ${totalUpdated}, deleted 0`,
    );
    logSkillBreakdown(skillCounts);
    return {
      fetched: totalFetched,
      inserted: totalInserted,
      updated: totalUpdated,
      deleted: 0,
    };
  }

  if (!cleanupEnabled) {
    console.log('[offerSync] Outside working hours — skipping offer cleanup');
    console.log(
      `[offerSync] Sync complete: fetched ${totalFetched}, inserted ${totalInserted}, updated ${totalUpdated}, deleted 0`,
    );
    logSkillBreakdown(skillCounts);
    return {
      fetched: totalFetched,
      inserted: totalInserted,
      updated: totalUpdated,
      deleted: 0,
    };
  }

  const deactivated = await prisma.offer.updateMany({
    where: {
      OR: [{ fetched_at: null }, { fetched_at: { lt: fetchedAt } }],
    },
    data: { is_active: false },
  });

  console.log(
    `[offerSync] Sync complete: fetched ${totalFetched}, inserted ${totalInserted}, updated ${totalUpdated}, deactivated ${deactivated.count}`,
  );
  logSkillBreakdown(skillCounts);

  return {
    fetched: totalFetched,
    inserted: totalInserted,
    updated: totalUpdated,
    deleted: deactivated.count,
  };
}
