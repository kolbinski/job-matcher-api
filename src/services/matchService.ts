import { randomUUID } from 'node:crypto';
import type { Offer } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getClaudeModel } from '../lib/claudeModels';
import { AppError } from '../lib/errors';
import { applyPreFilters } from './redFlagFilter';
import { scoreOffer } from './scoring';
import { evaluateOffers } from './claudeEvaluator';
import { normalizeProfile } from './profileParser';
import { CandidateProfileSchema } from '../types/profile';
import type {
  MatchResponse,
  MatchedOffer,
  UnmatchedOffer,
  OfferSalary,
  MatchFilters,
  StretchOffer,
} from '../types/match';
import { parseEmploymentTypes } from '../lib/offers';

export type MatchedPair = { offer: MatchedOffer; original: Offer };

const DEV_CLAUDE_MAX_BATCHES = 1;
const DEV_CLAUDE_BATCH_SIZE = 2;

export async function runMatchForUser(
  userId: string,
  opts?: {
    ai_scoring?: boolean;
    include_unmatched?: boolean;
    filters?: MatchFilters;
    sort?: { order?: 'asc' | 'desc' };
    syncStartedAt?: Date;
  },
): Promise<MatchResponse> {
  const startTime = Date.now();
  const callId = randomUUID();
  const matchingModel = await getClaudeModel('matching');
  const doAiScoring = opts?.ai_scoring ?? true;
  const includeUnmatched = opts?.include_unmatched ?? false;
  const sortOrder = opts?.sort?.order ?? 'desc';
  const syncStartedAt = opts?.syncStartedAt;

  // ── 1. Load profile + settings ────────────────────────────────────────────
  const [dbUser, claudeBatchSizeSetting] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { profile: true, email: true },
    }),
    prisma.settings.findUnique({ where: { key: 'claude_batch_size' } }),
  ]);
  if (!dbUser?.profile)
    throw new AppError(
      422,
      'INVALID_PROFILE',
      'No profile configured for this user',
    );
  const claudeBatchSize = DEV_CLAUDE_BATCH_SIZE;
  console.log(
    `[match] DEV limits active: max_batches=${DEV_CLAUDE_MAX_BATCHES} batch_size=${DEV_CLAUDE_BATCH_SIZE}`,
  );
  void claudeBatchSizeSetting;

  const profileParseResult = CandidateProfileSchema.safeParse(dbUser.profile);
  if (!profileParseResult.success) {
    console.error(
      '[matchService] Profile validation failed:',
      JSON.stringify(profileParseResult.error.issues),
    );
    throw new AppError(422, 'INVALID_PROFILE', 'Profile is invalid');
  }
  const profile = profileParseResult.data;

  const isTestUser =
    dbUser.email?.endsWith('@jobmatcher-test.invalid') ?? false;
  if (isTestUser && doAiScoring) {
    console.log(`[match] Test user ${userId} — skipping Claude API call`);
  }

  // ── 2. Normalize profile once ──────────────────────────────────────────────
  const norm = normalizeProfile(profile);

  // ── 3. Exclude already-processed offers ───────────────────────────────────
  const seenIds = new Set(
    (
      await prisma.userOffer.findMany({
        where: { user_id: userId },
        select: { offer_id: true },
      })
    ).map(r => r.offer_id),
  );

  // ── 4. Load active offers with skill pre-filter ────────────────────────────
  const candidateTechs = [...norm.techs];
  console.log('[preFilter] candidateTechs:', candidateTechs);
  const skillFilter =
    candidateTechs.length > 0
      ? {
          OR: [
            { required_skills: { isEmpty: true } },
            { required_skills: { hasSome: candidateTechs } },
          ],
        }
      : { required_skills: { isEmpty: true } };

  const whereClause = {
    AND: [
      { is_active: true },
      skillFilter,
      ...(seenIds.size > 0 ? [{ NOT: { id: { in: [...seenIds] } } }] : []),
    ],
  };

  const offers = await prisma.offer.findMany({ where: whereClause });

  // ── 5. Pre-filter + score ──────────────────────────────────────────────────
  const rejectedForDB: { offer_id: string; reason: string }[] = [];
  const pairs: MatchedPair[] = [];
  const unmatched: UnmatchedOffer[] = [];
  const rejectCounts = {
    workplace: 0,
    employment_type: 0,
    salary: 0,
    seniority: 0,
    language: 0,
    red_flags: 0,
    city: 0,
  };

  for (const offer of offers) {
    const result = applyPreFilters(profile, offer);
    if (!result.pass) {
      if (result.rejectedByWorkplace) rejectCounts.workplace++;
      if (result.rejectedByEmploymentType) rejectCounts.employment_type++;
      if (result.rejectedBySalary) rejectCounts.salary++;
      if (result.rejectedBySeniority) rejectCounts.seniority++;
      if (result.rejectedByLanguage) rejectCounts.language++;
      if (result.rejectedByRedFlags) rejectCounts.red_flags++;
      if (result.rejectedByCity) {
        rejectCounts.city++;
      }
      rejectedForDB.push({
        offer_id: offer.id,
        reason: result.reasons[0] ?? '',
      });
      if (includeUnmatched)
        unmatched.push(toUnmatchedOffer(offer, result.reasons));
      continue;
    }
    pairs.push({
      offer: toMatchedOffer(offer, scoreOffer(norm, offer)),
      original: offer,
    });
  }

  // ── 6. Skill-excluded offers (no SQL skill overlap) ────────────────────────
  const processedIds = new Set(offers.map(o => o.id));
  const skillExcluded = await prisma.offer.findMany({
    where: { is_active: true, id: { notIn: [...seenIds, ...processedIds] } },
    select: { id: true },
  });
  for (const { id } of skillExcluded) {
    rejectedForDB.push({
      offer_id: id,
      reason: 'No skills match candidate profile',
    });
  }

  console.log(`[preFilter] workplace: rejected ${rejectCounts.workplace}`);
  console.log(
    `[preFilter] employment_type: rejected ${rejectCounts.employment_type}`,
  );
  console.log(`[preFilter] salary: rejected ${rejectCounts.salary}`);
  console.log(`[preFilter] seniority: rejected ${rejectCounts.seniority}`);
  console.log(`[preFilter] language: rejected ${rejectCounts.language}`);
  console.log(`[preFilter] red_flags: rejected ${rejectCounts.red_flags}`);
  console.log(`[preFilter] city: rejected ${rejectCounts.city}`);
  console.log(`[preFilter] skill_excluded: ${skillExcluded.length}`);
  console.log(
    '[preFilter] skill_excluded for user:',
    userId,
    'candidateTechs:',
    candidateTechs,
  );
  console.log(`[preFilter] total passed: ${pairs.length} → sending to Claude`);

  // ── 6b. Write pre_filter_rejected rows immediately ────────────────────────
  // Inserting before Claude so seenIds on the next sync excludes these offers,
  // preventing re-evaluation of already-rejected offers.
  const now = new Date();
  let newlyInserted = 0;
  const preFilterRows = rejectedForDB.map(({ offer_id, reason }) => ({
    user_id: userId,
    offer_id,
    status: 'pre_filter_rejected',
    rejection_reason: reason || null,
    claude_matched_reasons: { pros: [], cons: [] } as {
      pros: string[];
      cons: string[];
    },
    claude_missing_skills: [] as string[],
    matched_at: now,
    updated_at: now,
  }));
  if (preFilterRows.length > 0) {
    const existingOffers = await prisma.offer.findMany({
      where: { id: { in: preFilterRows.map(r => r.offer_id) } },
      select: { id: true },
    });
    const existingIds = new Set(existingOffers.map(o => o.id));
    const validPreFilterRows = preFilterRows.filter(r =>
      existingIds.has(r.offer_id),
    );
    if (validPreFilterRows.length !== preFilterRows.length) {
      console.warn(
        `[match] Skipping ${preFilterRows.length - validPreFilterRows.length} pre_filter rows with missing offer_ids`,
      );
    }
    const chunkSize = 100;
    for (let i = 0; i < validPreFilterRows.length; i += chunkSize) {
      const r = await prisma.userOffer.createMany({
        data: validPreFilterRows.slice(i, i + chunkSize),
        skipDuplicates: true,
      });
      newlyInserted += r.count;
    }
    console.log(
      `[match] Saved ${validPreFilterRows.length} pre_filter_rejected rows`,
    );
    const newPreFilter = await prisma.userOffer.findMany({
      where: {
        user_id: userId,
        status: 'pre_filter_rejected',
        matched_at: now,
      },
      select: { id: true },
    });
    if (newPreFilter.length > 0) {
      await prisma.userOfferStatus.createMany({
        data: newPreFilter.map(r => ({
          user_offer_id: r.id,
          status: 'pre_filter_rejected',
        })),
      });
    }
  }

  // ── 7. Sort + post-score filters ───────────────────────────────────────────
  pairs.sort((a, b) =>
    sortOrder === 'asc'
      ? a.offer.score - b.offer.score
      : b.offer.score - a.offer.score,
  );
  const filteredPairs = applyPostScoreFilters(pairs, opts?.filters);

  // ── 8. Claude evaluation — insert each batch immediately after evaluation ──
  // Rows are persisted before the next Claude API call so a mid-run failure
  // leaves already-processed batches saved and seenIds grows with each batch.
  let aiScoring = false;
  let claudeEvaluationsCount = 0;

  if (doAiScoring && !isTestUser && filteredPairs.length === 0) {
    console.log('[match] No offers to evaluate — skipping Claude API call');
  } else if (doAiScoring && !isTestUser) {
    const allBatches: (typeof filteredPairs)[] = [];
    for (let i = 0; i < filteredPairs.length; i += claudeBatchSize) {
      allBatches.push(filteredPairs.slice(i, i + claudeBatchSize));
    }
    const batchesToProcess = allBatches.slice(0, DEV_CLAUDE_MAX_BATCHES);
    if (batchesToProcess.length < allBatches.length) {
      console.log(
        `[match] CLAUDE_MAX_BATCHES limit applied: processing ${batchesToProcess.length} of ${allBatches.length} batches`,
      );
    }
    const totalBatches = batchesToProcess.length;
    const CONCURRENCY = 3;

    const processBatch = async (
      batch: typeof filteredPairs,
      batchNum: number,
    ): Promise<void> => {
      console.log(
        `[match] Claude batch ${batchNum}/${totalBatches} (${batch.length} offers)`,
      );

      const batchResults = await evaluateOffers(
        profile,
        batch.map(p => p.original),
        matchingModel,
      );
      if (!batchResults) {
        console.warn(
          `[match] Claude batch ${batchNum}/${totalBatches} returned null — skipping`,
        );
        prisma.apiCall
          .create({
            data: {
              user_id: userId,
              offers_matched: 0,
              offers_total: batch.length,
              status: 'error',
              call_type: 'matching',
              model: matchingModel,
            },
          })
          .catch(err =>
            console.error('[match] Failed to log error api_call:', err),
          );
        return;
      }

      // Apply evaluations to this batch's pairs in-place
      const cvLanguageByIndex = new Map<number, 'pl' | 'en'>();
      for (const ev of batchResults.evaluations) {
        if (ev.offer_index < 0 || ev.offer_index >= batch.length) continue;
        const p = batch[ev.offer_index];
        p.offer.score = ev.score;
        p.offer.rank = ev.rank;
        p.offer.matched_reasons = ev.matched_reasons;
        p.offer.missing_skills = ev.missing_skills;
        p.offer.salary_comparison = ev.salary_comparison;
        p.offer.role_fit = ev.role_fit;
        p.offer.recommended = ev.recommended;
        cvLanguageByIndex.set(ev.offer_index, ev.offer_language);
        claudeEvaluationsCount++;
      }

      // Insert this batch's rows immediately
      const batchRows = batch
        .filter(p => p.offer.recommended !== null && p.original.id != null)
        .map((p, idx) => {
          const isPendingApply =
            p.offer.recommended === true && p.offer.role_fit !== null;
          return {
            user_id: userId,
            offer_id: p.original.id,
            status: isPendingApply ? 'pending_apply' : 'ai_rejected',
            rejection_reason: !isPendingApply
              ? (p.offer.role_fit ?? null)
              : null,
            claude_score: p.offer.score,
            claude_role_fit: p.offer.role_fit ?? null,
            claude_matched_reasons: p.offer.matched_reasons,
            claude_missing_skills: p.offer.missing_skills,
            claude_salary_comparison: p.offer.salary_comparison ?? null,
            claude_recommended: p.offer.recommended,
            cv_language: cvLanguageByIndex.get(idx) ?? 'en',
            matched_at: now,
            updated_at: now,
          };
        });

      let batchPendingApplyCount = 0;
      if (batchRows.length > 0) {
        const existingClaudeOffers = await prisma.offer.findMany({
          where: { id: { in: batchRows.map(r => r.offer_id) } },
          select: { id: true },
        });
        const existingClaudeIds = new Set(existingClaudeOffers.map(o => o.id));
        const validBatchRows = batchRows.filter(r =>
          existingClaudeIds.has(r.offer_id),
        );
        if (validBatchRows.length !== batchRows.length) {
          console.warn(
            `[match] Skipping ${batchRows.length - validBatchRows.length} claude rows with missing offer_ids`,
          );
        }
        if (validBatchRows.length > 0) {
          if (syncStartedAt !== undefined) {
            const user = await prisma.user.findUnique({
              where: { id: userId },
              select: { sync_started_at: true },
            });
            if (user?.sync_started_at?.getTime() !== syncStartedAt.getTime()) {
              console.log(
                `[match] Batch ${batchNum}: sync superseded, skipping insert`,
              );
              return;
            }
          } else {
            const userExists = await prisma.user.findUnique({
              where: { id: userId },
              select: { id: true },
            });
            if (!userExists) {
              console.log(
                `[match] Batch ${batchNum}: user no longer exists, aborting insert`,
              );
              return;
            }
          }
          const writeResult = await prisma.userOffer.createMany({
            data: validBatchRows,
            skipDuplicates: true,
          });
          newlyInserted += writeResult.count;
          if (writeResult.count > 0) {
            aiScoring = true;
            const inserted = await prisma.userOffer.findMany({
              where: {
                user_id: userId,
                offer_id: { in: validBatchRows.map(r => r.offer_id) },
                matched_at: now,
              },
              select: { id: true, status: true, claude_recommended: true },
            });
            await prisma.userOfferStatus.createMany({
              data: inserted.map(r => ({
                user_offer_id: r.id,
                status: r.status,
              })),
            });
            batchPendingApplyCount = inserted.filter(
              r => r.status === 'pending_apply',
            ).length;
            const applyNowCount = inserted.filter(
              r => r.claude_recommended === true,
            ).length;
            const levelUpCount = inserted.filter(
              r => r.claude_recommended === false,
            ).length;
            console.log(
              `[match] Batch ${batchNum}: inserted ${writeResult.count} rows — ${batchPendingApplyCount} pending_apply (${applyNowCount} apply now, ${levelUpCount} level up)`,
            );
          } else {
            console.log(
              `[match] Batch ${batchNum}: inserted ${writeResult.count} rows — ${batchPendingApplyCount} pending_apply`,
            );
          }
        }
      }

      prisma.apiCall
        .create({
          data: {
            user_id: userId,
            offers_matched: batchPendingApplyCount,
            offers_total: batch.length,
            response_ms: batchResults.response_ms,
            status: 'success',
            call_type: 'matching',
            model: batchResults.model,
            input_tokens: batchResults.input_tokens,
            output_tokens: batchResults.output_tokens,
          },
        })
        .catch(err =>
          console.error('[match] Failed to log api_call for batch:', err),
        );
    };

    for (let i = 0; i < batchesToProcess.length; i += CONCURRENCY) {
      const group = batchesToProcess.slice(i, i + CONCURRENCY);
      await Promise.all(
        group.map((batch, j) => processBatch(batch, i + j + 1)),
      );
    }

    // Re-sort by Claude score once all batches are done
    if (aiScoring) {
      filteredPairs.sort((a, b) => b.offer.score - a.offer.score);
    }
  }

  // ── 10. Stretch offers (runs after user_offers write) ─────────────────────
  const learningGoals = (profile.preferences.learning_skills_goals ?? []).map(
    g => g.toLowerCase(),
  );
  const stretchOffers = await buildStretchOffers(userId, learningGoals, prisma);

  const responseMs = Date.now() - startTime;
  const limitedMatched = filteredPairs.map(p => p.offer);
  if (limitedMatched.length > 0) {
    const first = limitedMatched[0];
    console.log(
      '[match] First offer Claude fields — role_fit:',
      first.role_fit,
      '| recommended:',
      first.recommended,
    );
  }

  return {
    meta: {
      call_id: callId,
      generated_at: new Date().toISOString(),
      response_ms: responseMs,
      total_offers_scanned: offers.length + skillExcluded.length,
      newly_inserted: newlyInserted,
      matched_count: limitedMatched.length,
      unmatched_count: unmatched.length,
      ai_scoring: aiScoring,
      claude_evaluations_count: claudeEvaluationsCount,
    },
    matched: limitedMatched,
    unmatched: includeUnmatched ? unmatched : [],
    stretch_offers: stretchOffers,
  };
}

// ─── Salary helpers ───────────────────────────────────────────────────────────

export function extractAllSalaries(offer: Offer): OfferSalary[] {
  const types = parseEmploymentTypes(offer);
  return types
    .filter(t => t.from !== undefined && t.to !== undefined)
    .map(t => ({
      from: t.from!,
      to: t.to!,
      currency: t.currency ?? 'PLN',
      type: t.type ?? 'unknown',
      unit: t.unit,
    }));
}

export function extractSalary(offer: Offer): OfferSalary | null {
  const types = parseEmploymentTypes(offer);
  if (types.length === 0) return null;
  for (const t of types) {
    if (t.type === 'contract' && t.from !== undefined && t.to !== undefined) {
      return {
        from: t.from,
        to: t.to,
        currency: t.currency ?? 'PLN',
        type: 'contract',
        unit: t.unit,
      };
    }
  }
  for (const t of types) {
    if (t.from !== undefined && t.to !== undefined) {
      return {
        from: t.from,
        to: t.to,
        currency: t.currency ?? 'PLN',
        type: t.type ?? 'unknown',
        unit: t.unit,
      };
    }
  }
  return null;
}

// learningGoals must already be lowercased by the caller.
// Two-query approach avoids Prisma include INNER JOIN silently dropping rows
// whose related offer is inactive or deleted.
export async function buildStretchOffers(
  userId: string,
  learningGoals: string[],
  db: typeof prisma,
): Promise<StretchOffer[]> {
  if (learningGoals.length === 0) return [];

  const rows = await db.userOffer.findMany({
    where: { user_id: userId, status: 'ai_rejected' },
  });

  console.log(
    '[stretch] ai_rejected candidates:',
    rows.length,
    'learning_skills_goals:',
    learningGoals,
  );

  const filtered = rows
    .filter(row => {
      const missing = row.claude_missing_skills.map(s => s.toLowerCase());
      if (missing.length === 0) return false;
      const overlapCount = learningGoals.filter(goal =>
        missing.includes(goal),
      ).length;
      return overlapCount / missing.length >= 0.5;
    })
    .sort((a, b) => (b.claude_score ?? 0) - (a.claude_score ?? 0));

  if (filtered.length === 0) return [];

  const offerIds = filtered.map(r => r.offer_id);
  const offers = await db.offer.findMany({ where: { id: { in: offerIds } } });
  const offerById = new Map(offers.map(o => [o.id, o]));

  return filtered.flatMap(row => {
    const offer = offerById.get(row.offer_id);
    if (!offer) return [];
    return [
      {
        title: offer.title,
        company_name: offer.company_name,
        experience_level: offer.experience_level ?? null,
        workplace_type: offer.workplace_type ?? null,
        working_time: offer.working_time ?? null,
        required_skills: offer.required_skills,
        nice_to_have_skills: offer.nice_to_have_skills,
        employment_types: offer.employment_types,
        salary: extractSalary(offer),
        salaries: extractAllSalaries(offer),
        role_fit: row.claude_role_fit,
        missing_skills: row.claude_missing_skills,
        url: offer.url,
        city: offer.city ?? null,
        remote: offer.workplace_type === 'remote',
        hybrid:
          offer.workplace_type === 'hybrid' ||
          offer.workplace_type === 'partly_remote',
        source: offer.source,
      },
    ];
  });
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function toMatchedOffer(
  offer: Offer,
  scored: ReturnType<typeof scoreOffer>,
): MatchedOffer {
  return {
    score: scored.score,
    title: offer.title,
    company: offer.company_name,
    city: offer.city,
    remote: offer.workplace_type === 'remote',
    hybrid:
      offer.workplace_type === 'hybrid' ||
      offer.workplace_type === 'partly_remote',
    experience_level: offer.experience_level,
    workplace_type: offer.workplace_type ?? null,
    working_time: offer.working_time ?? null,
    required_skills: offer.required_skills,
    nice_to_have_skills: offer.nice_to_have_skills,
    employment_types: offer.employment_types,
    salary: extractSalary(offer),
    salaries: extractAllSalaries(offer),
    matched_reasons: { pros: scored.matchReasons, cons: [] },
    missing_skills: scored.missingSkills,
    red_flags_found: [],
    rank: null,
    salary_comparison: null,
    role_fit: null,
    recommended: null,
    url: offer.url,
    source: offer.source,
    fetched_at: offer.fetched_at?.toISOString() ?? null,
  };
}

function toUnmatchedOffer(
  offer: Offer,
  rejectionReasons: string[],
): UnmatchedOffer {
  return {
    score: 0,
    title: offer.title,
    company: offer.company_name,
    city: offer.city,
    remote: offer.workplace_type === 'remote',
    hybrid:
      offer.workplace_type === 'hybrid' ||
      offer.workplace_type === 'partly_remote',
    salary: extractSalary(offer),
    rejection_reasons: rejectionReasons,
    required_skills: offer.required_skills,
    url: offer.url,
    source: offer.source,
  };
}

function applyPostScoreFilters(
  pairs: MatchedPair[],
  filters?: MatchFilters,
): MatchedPair[] {
  if (!filters) return pairs;
  return pairs.filter(({ offer: o }) => {
    if (filters.min_score !== undefined && o.score < filters.min_score)
      return false;
    if (filters.remote && !o.remote) return false;
    if (filters.hybrid && !o.hybrid) return false;
    if (filters.cities?.length) {
      const city = o.city?.toLowerCase();
      if (!city || !filters.cities.some(c => c.toLowerCase() === city))
        return false;
    }
    if (filters.experience_level?.length) {
      const level = o.experience_level?.toLowerCase();
      if (
        !level ||
        !filters.experience_level.includes(
          level as 'junior' | 'mid' | 'senior' | 'c-level' | 'expert',
        )
      )
        return false;
    }
    if (filters.sources?.length && !filters.sources.includes(o.source))
      return false;
    if (
      filters.salary_min !== undefined &&
      o.salary &&
      o.salary.from < filters.salary_min
    )
      return false;
    if (
      filters.salary_max !== undefined &&
      o.salary &&
      o.salary.to > filters.salary_max
    )
      return false;
    return true;
  });
}
