import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { validateJwt } from '../middleware/validateJwt';
import { dedupKey } from '../utils/deduplicateOffers';
import { calculateUserOfferSalary } from '../lib/salaryCalculator';

export const userOffersRouter = Router();

const QuerySchema = z.object({
  client_id: z.string().min(1).optional(),
  status: z.string().min(1),
  has_learning_skills_goals: z.enum(['true', 'false']).optional(),
  count_only: z.enum(['true', 'false']).optional(),
  source: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  min_score: z.coerce.number().int().min(0).optional(),
  generated_cv: z.enum(['true', 'false']).optional(),
  generated_cl: z.enum(['true', 'false']).optional(),
  sort_by: z.enum(['score', 'salary_delta']).optional(),
  known_apply_count: z.coerce.number().int().min(0).optional(),
  known_level_up_count: z.coerce.number().int().min(0).optional(),
});

interface ClientProfile {
  learningGoals: string[];
}

async function loadClientProfile(clientId: string): Promise<ClientProfile> {
  const user = await prisma.user.findUnique({
    where: { id: clientId },
    select: { profile: true },
  });
  if (!user?.profile) return { learningGoals: [] };
  try {
    const raw = user.profile as {
      preferences?: { learning_skills_goals?: string[] };
    };
    return {
      learningGoals: (raw.preferences?.learning_skills_goals ?? []).map(g =>
        g.toLowerCase(),
      ),
    };
  } catch {
    return { learningGoals: [] };
  }
}

function hasSalaryData(types: unknown): boolean {
  if (!Array.isArray(types) || types.length === 0) return false;
  return (types as Array<{ from?: number | null; to?: number | null }>).some(
    et =>
      (typeof et.from === 'number' && et.from > 0) ||
      (typeof et.to === 'number' && et.to > 0),
  );
}

const StatusBodySchema = z.object({
  status: z.enum([
    'applied',
    'agent_withdrawn',
    'recruiter_rejected',
    'offer_received',
    'accepted',
    'client_withdrawn',
  ]),
});

userOffersRouter.get('/by-url', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!;
  if (role !== 'client') {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Only clients can use this endpoint',
    });
  }

  const url = req.query['url'] as string | undefined;
  if (!url) {
    return res.status(422).json({
      error: 'INVALID_REQUEST',
      message: 'Missing required query param: url',
    });
  }

  const [offer, dbUser, exchangeRatesSetting] = await Promise.all([
    prisma.offer.findFirst({ where: { url } }),
    prisma.user.findUnique({
      where: { id: user_id! },
      select: { preferred_currency: true, profile: true },
    }),
    prisma.settings.findUnique({ where: { key: 'exchange_rates' } }),
  ]);
  if (!offer) return res.json({ user_offer: null });

  const uo = await prisma.userOffer.findFirst({
    where: { offer_id: offer.id, user_id: user_id! },
    include: {
      offer: {
        select: {
          title: true,
          company_name: true,
          url: true,
          employment_types: true,
          source: true,
          city: true,
          workplace_type: true,
          experience_level: true,
          working_time: true,
          required_skills: true,
          nice_to_have_skills: true,
        },
      },
      status_history: {
        where: { status: 'applied' },
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
  });
  if (!uo) return res.json({ user_offer: null });

  const preferredCurrency = dbUser?.preferred_currency ?? 'USD';
  const exchangeRates: Record<string, number> = exchangeRatesSetting
    ? (JSON.parse(exchangeRatesSetting.value) as Record<string, number>)
    : {};
  const rawProfile = dbUser?.profile as { preferences?: { salary?: Array<{ type: string; currency: string; min: number; unit?: string }> } } | null;
  const salaryPrefs = (rawProfile?.preferences?.salary ?? []).map(p => ({
    type: p.type,
    currency: p.currency,
    min: p.min,
    unit: p.unit,
  }));

  const salaryResult = calculateUserOfferSalary(
    Array.isArray(uo.offer.employment_types) ? uo.offer.employment_types : [],
    preferredCurrency,
    salaryPrefs,
    exchangeRates,
  );

  const raw_salaries = Array.isArray(uo.offer.employment_types)
    ? (uo.offer.employment_types as Array<Record<string, unknown>>).map(et => ({
        from: et['fromPerUnit'] ?? et['from'] ?? null,
        to: et['toPerUnit'] ?? et['to'] ?? null,
        currency: et['currency'] ?? null,
        unit: et['unit'] ?? null,
        type: et['type'] ?? null,
      }))
    : [];

  return res.json({
    user_offer: {
      user_offer_id: uo.id,
      offer_id: uo.offer_id,
      offer_title: uo.offer.title,
      offer_company: uo.offer.company_name,
      offer_url: uo.offer.url,
      claude_score: uo.claude_score,
      claude_role_fit: uo.claude_role_fit,
      claude_matched_reasons: uo.claude_matched_reasons,
      claude_missing_skills: uo.claude_missing_skills,
      claude_recommended: uo.claude_recommended,
      rejection_reason: uo.rejection_reason,
      matched_at: uo.matched_at,
      applied_at: uo.status_history[0]?.created_at ?? null,
      salary: salaryResult
        ? [{ min: salaryResult.salary_min, max: salaryResult.salary_max, currency: salaryResult.salary_currency, delta: salaryResult.salary_delta, type: salaryResult.salary_type ?? '' }]
        : [],
      raw_salaries,
      source: uo.offer.source,
      city: uo.offer.city ?? null,
      work_model: uo.offer.workplace_type ?? null,
      required_skills: uo.offer.required_skills,
      nice_to_have_skills: uo.offer.nice_to_have_skills,
      cv_language: uo.cv_language,
      cv_status: uo.cv_status ?? null,
      cv_url: uo.cv_url ?? null,
      cl_status: uo.cl_status ?? null,
      cl_url: uo.cl_url ?? null,
      status: uo.status,
    },
  });
});

userOffersRouter.patch('/:id/role-fit', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const { id } = req.params as { id: string }
  const roleFit = req.body?.claude_role_fit
  if (typeof roleFit !== 'string' || !roleFit.trim()) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'claude_role_fit must be a non-empty string' })
  }

  const userOffer = await prisma.userOffer.findFirst({ where: { id, user_id: user_id! } })
  if (!userOffer) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'User offer not found or does not belong to you' })
  }

  await prisma.userOffer.update({ where: { id }, data: { claude_role_fit: roleFit } })

  return res.json({ success: true })
})

userOffersRouter.patch('/:id/status', validateJwt, async (req, res) => {
  const { id } = req.params as { id: string };
  const parsed = StatusBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ error: 'INVALID_REQUEST', message: 'Invalid status value' });
  }

  const { role, user_id, agent_id } = req.jwt!;

  if (role === 'client') {
    const userOffer = await prisma.userOffer.findFirst({
      where: { id, user_id: user_id! },
    });
    if (!userOffer) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'User offer not found or does not belong to you' });
    }
  } else {
    if (!agent_id) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Agent ID missing from token' });
    }

    const userOffer = await prisma.userOffer.findUnique({
      where: { id },
      select: { id: true, user_id: true },
    });
    if (!userOffer) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'User offer not found' });
    }

    const agentClient = await prisma.agentClient.findUnique({
      where: { agent_id_user_id: { agent_id, user_id: userOffer.user_id } },
    });
    if (!agentClient) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'User offer does not belong to your client' });
    }
  }

  const updated = await prisma.userOffer.update({
    where: { id },
    data: { status: parsed.data.status },
  });

  await prisma.userOfferStatus.create({
    data: { user_offer_id: id, status: parsed.data.status },
  });

  return res.json(updated);
});

userOffersRouter.get('/', validateJwt, async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(422).json({
      error: 'INVALID_REQUEST',
      message: 'Missing required query param: status',
      issues: parsed.error.issues,
    });
  }

  const {
    status,
    has_learning_skills_goals,
    count_only,
    source,
    date_from,
    date_to,
    page: pageParam,
    min_score: minScoreParam,
    generated_cv,
    generated_cl,
    sort_by: sortBy,
    known_apply_count: knownApplyCount,
    known_level_up_count: knownLevelUpCount,
  } = parsed.data;
  const page = pageParam ?? 1;
  const minScore = minScoreParam ?? 0;

  const filterSnapshotOffers = (offers: unknown[]): unknown[] => {
    let arr = offers as Array<Record<string, unknown>>;
    if (minScore > 0) arr = arr.filter(o => ((o['claude_score'] as number | null) ?? 0) >= minScore);
    if (generated_cv === 'true') arr = arr.filter(o => o['cv_status'] === 'done');
    if (generated_cl === 'true') arr = arr.filter(o => o['cl_status'] === 'done');
    return arr;
  };
  const { role, agent_id, user_id } = req.jwt!;

  let clientId: string;

  if (role === 'client') {
    clientId = user_id!;
  } else {
    if (!parsed.data.client_id) {
      return res.status(422).json({
        error: 'INVALID_REQUEST',
        message: 'Missing required query param: client_id',
      });
    }
    clientId = parsed.data.client_id;

    const agentClient = await prisma.agentClient.findUnique({
      where: { agent_id_user_id: { agent_id: agent_id!, user_id: clientId } },
    });
    if (!agentClient) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Client not linked to this agent',
      });
    }
  }

  const statuses = status
    .split('|')
    .map(s => s.trim())
    .filter(Boolean);

  // ── Multi-status path ──────────────────────────────────────────────────────
  if (statuses.length > 1) {
    const [{ learningGoals }, subscription, pageSizeSetting, dbUser, exchangeRatesSetting] =
      await Promise.all([
        loadClientProfile(clientId),
        role === 'client'
          ? prisma.subscription.findUnique({
              where: { user_id: clientId },
              include: { plan: true },
            })
          : Promise.resolve(null),
        prisma.settings.findUnique({ where: { key: 'listing_offers_page_size' } }),
        prisma.user.findUnique({
          where: { id: clientId },
          select: { preferred_currency: true, profile: true },
        }),
        prisma.settings.findUnique({ where: { key: 'exchange_rates' } }),
      ]);
    const preferredCurrency = dbUser?.preferred_currency ?? 'USD';
    const exchangeRates: Record<string, number> = exchangeRatesSetting
      ? (JSON.parse(exchangeRatesSetting.value) as Record<string, number>)
      : {};
    const rawProfile = dbUser?.profile as { preferences?: { salary?: Array<{ type: string; currency: string; min: number; unit?: string }> } } | null;
    const salaryPrefs = (rawProfile?.preferences?.salary ?? []).map(p => ({
      type: p.type,
      currency: p.currency,
      min: p.min,
      unit: p.unit,
    }));
    const pageSize = parseInt(pageSizeSetting?.value ?? '10', 10) || 10;
    const start = (page - 1) * pageSize;
    const effectivePlan =
      subscription?.plan ??
      (role === 'client'
        ? await prisma.plan.findUnique({ where: { name: 'free' } })
        : null);
    const limits = effectivePlan?.limits as {
      max_apply_now: number | null;
      max_level_up: number | null;
    } | null;


    if (role === 'client' && effectivePlan?.name === 'free') {
      const userWithSnapshot = await prisma.user.findUnique({
        where: { id: clientId },
        select: { free_plan_snapshot: true },
      });
      if (userWithSnapshot?.free_plan_snapshot != null) {
        const snap = userWithSnapshot.free_plan_snapshot as {
          count?: number;
          apply_now?: { status: string; count: number; has_more?: boolean; offers: unknown[] };
          level_up?: { status: string; count: number; has_more?: boolean; offers: unknown[] };
        };
        const applyNowOffers = filterSnapshotOffers(snap.apply_now?.offers ?? []);
        const levelUpOffers = filterSnapshotOffers(snap.level_up?.offers ?? []);
        return res.json({
          ...snap,
          count: applyNowOffers.length + levelUpOffers.length,
          ...(snap.apply_now ? { apply_now: { ...snap.apply_now, count: applyNowOffers.length, offers: applyNowOffers } } : {}),
          ...(snap.level_up ? { level_up: { ...snap.level_up, count: levelUpOffers.length, offers: levelUpOffers } } : {}),
        });
      }
    }

    const offerSelect = {
      title: true,
      company_name: true,
      url: true,
      employment_types: true,
      source: true,
      city: true,
      workplace_type: true,
      experience_level: true,
      working_time: true,
      required_skills: true,
      nice_to_have_skills: true,
    } as const;

    const buckets: Record<
      string,
      { status: string; count: number; has_more: boolean; offers: unknown[] }
    > = {};

    for (const bucketStatus of statuses) {
      const bucketOfferWhere = {
        ...(source && source !== 'all' ? { source } : {}),
        ...(bucketStatus === 'ai_rejected'
          ? { employment_types: { not: [] as Prisma.InputJsonValue } }
          : {}),
      };
      const isScoreRelevant = bucketStatus === 'pending_apply' || bucketStatus === 'ai_rejected';
      const bucketWhere = {
        user_id: clientId,
        status: bucketStatus,
        ...(isScoreRelevant && minScore > 0 ? { claude_score: { gte: minScore } } : {}),
        ...(generated_cv === 'true' ? { cv_status: 'done' } : {}),
        ...(generated_cl === 'true' ? { cl_status: 'done' } : {}),
        ...(Object.keys(bucketOfferWhere).length > 0
          ? { offer: bucketOfferWhere }
          : {}),
      };

      const rows = await prisma.userOffer.findMany({
        where: bucketWhere,
        include: {
          offer: { select: offerSelect },
          status_history: {
            where: { status: 'applied' },
            orderBy: { created_at: 'desc' },
            take: 1,
          },
        },
        orderBy: sortBy === 'salary_delta'
          ? [{ salary_delta: { sort: 'desc', nulls: 'last' } }, { claude_score: 'desc' }]
          : [{ claude_score: 'desc' }],
      });

      // Dedup
      const seen = new Map<string, (typeof rows)[number]>();
      for (const uo of rows) {
        const key = dedupKey(uo.offer);
        const prev = seen.get(key);
        if (!prev) {
          seen.set(key, uo);
        } else {
          const prevScore = prev.claude_score ?? -1;
          const newScore = uo.claude_score ?? -1;
          if (
            newScore > prevScore ||
            (newScore === prevScore && uo.matched_at > prev.matched_at)
          ) {
            seen.set(key, uo);
          }
        }
      }

      let result = [...seen.values()];

      // Auto-apply filters for ai_rejected bucket
      if (bucketStatus === 'ai_rejected') {
        result = result.filter(uo => hasSalaryData(uo.offer.employment_types));
        if (learningGoals.length > 0) {
          result = result.filter(uo =>
            uo.claude_missing_skills.some(sk =>
              learningGoals.includes(sk.toLowerCase()),
            ),
          );
        }
      }

      const mapped = result.map(uo => {
        const salaryResult = calculateUserOfferSalary(
          Array.isArray(uo.offer.employment_types) ? uo.offer.employment_types : [],
          preferredCurrency,
          salaryPrefs,
          exchangeRates,
        );
        return {
          user_offer_id: uo.id,
          offer_id: uo.offer_id,
          offer_title: uo.offer.title,
          offer_company: uo.offer.company_name,
          offer_url: uo.offer.url,
          claude_score: uo.claude_score,
          claude_role_fit: uo.claude_role_fit,
          claude_matched_reasons: uo.claude_matched_reasons,
          claude_missing_skills: uo.claude_missing_skills,
          claude_recommended: uo.claude_recommended,
          rejection_reason: uo.rejection_reason,
          matched_at: uo.matched_at,
          applied_at: uo.status_history[0]?.created_at ?? null,
          salary: salaryResult
            ? [{ min: salaryResult.salary_min, max: salaryResult.salary_max, currency: salaryResult.salary_currency, delta: salaryResult.salary_delta, type: salaryResult.salary_type ?? '' }]
            : [],
          salary_delta: uo.salary_delta,
          raw_salaries: Array.isArray(uo.offer.employment_types)
            ? (uo.offer.employment_types as Array<Record<string, unknown>>).map(et => ({
                from: et['fromPerUnit'] ?? et['from'] ?? null,
                to: et['toPerUnit'] ?? et['to'] ?? null,
                currency: et['currency'] ?? null,
                unit: et['unit'] ?? null,
                type: et['type'] ?? null,
              }))
            : [],
          source: uo.offer.source,
          city: uo.offer.city ?? null,
          work_model: uo.offer.workplace_type ?? null,
          required_skills: uo.offer.required_skills,
          nice_to_have_skills: uo.offer.nice_to_have_skills,
          cv_language: uo.cv_language,
          cv_status: uo.cv_status ?? null,
          cv_url: uo.cv_url ?? null,
          cl_status: uo.cl_status ?? null,
          cl_url: uo.cl_url ?? null,
          status: uo.status,
        };
      });

      const finalMapped = bucketStatus === 'ai_rejected'
        ? mapped.filter(o => o.salary.length > 0)
        : mapped;

      const count = finalMapped.length;
      let offers: typeof finalMapped = finalMapped;

      if (role === 'client' && limits != null) {
        const byScoreAndDelta = (
          a: (typeof finalMapped)[number],
          b: (typeof finalMapped)[number],
        ) =>
          (b.claude_score ?? 0) - (a.claude_score ?? 0) ||
          (b.salary_delta ?? -Infinity) - (a.salary_delta ?? -Infinity);

        if (bucketStatus === 'pending_apply' && limits.max_apply_now != null) {
          offers = [...finalMapped]
            .sort(byScoreAndDelta)
            .slice(0, limits.max_apply_now);
        } else if (
          bucketStatus === 'ai_rejected' &&
          limits.max_level_up != null
        ) {
          offers = [...finalMapped]
            .sort(byScoreAndDelta)
            .slice(0, limits.max_level_up);
        }
      }

      offers = [...offers].sort((a, b) => {
        if (sortBy === 'salary_delta') {
          const da = a.salary_delta
          const db = b.salary_delta
          if (da !== db) {
            if (da === null) return 1
            if (db === null) return -1
            return db - da
          }
        }
        const scoreDiff = (b.claude_score ?? 0) - (a.claude_score ?? 0)
        if (scoreDiff !== 0) return scoreDiff
        return (a.work_model === 'remote' ? 0 : 1) - (b.work_model === 'remote' ? 0 : 1)
      })

      const pagedOffers = offers.slice(start, start + pageSize);
      const has_more = offers.length > start + pageSize;

      buckets[bucketStatus] = { status: bucketStatus, count, has_more, offers: pagedOffers };
    }

    const totalCount = Object.values(buckets).reduce(
      (sum, b) => sum + b.count,
      0,
    );
    const bucketKeyMap: Record<string, string> = {
      pending_apply: 'apply_now',
      ai_rejected: 'level_up',
    }
    const namedBuckets = Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [bucketKeyMap[k] ?? k, v]),
    )

    if (knownApplyCount !== undefined && namedBuckets['apply_now'] && knownApplyCount === namedBuckets['apply_now'].count) {
      namedBuckets['apply_now'] = { ...namedBuckets['apply_now'], offers: [] };
    }
    if (knownLevelUpCount !== undefined && namedBuckets['level_up'] && knownLevelUpCount === namedBuckets['level_up'].count) {
      namedBuckets['level_up'] = { ...namedBuckets['level_up'], offers: [] };
    }

    return res.json({ count: totalCount, ...namedBuckets });
  }

  // ── Single-status path (backward compatible) ───────────────────────────────
  const offerWhere = {
    ...(source && source !== 'all' ? { source } : {}),
    ...(status === 'ai_rejected'
      ? { employment_types: { not: [] as Prisma.InputJsonValue } }
      : {}),
  };
  const isScoreStatus = status === 'pending_apply' || status === 'ai_rejected';
  const where = {
    user_id: clientId,
    status,
    ...(isScoreStatus && minScore > 0 ? { claude_score: { gte: minScore } } : {}),
    ...(generated_cv === 'true' ? { cv_status: 'done' } : {}),
    ...(generated_cl === 'true' ? { cl_status: 'done' } : {}),
    ...(Object.keys(offerWhere).length > 0 ? { offer: offerWhere } : {}),
  };

  // count_only for ai_rejected: must filter in memory to check real salary data
  if (count_only === 'true' && status === 'ai_rejected') {
    const rows = await prisma.userOffer.findMany({
      where,
      select: {
        claude_missing_skills: true,
        offer: { select: { employment_types: true } },
      },
    });
    let filtered = rows.filter(uo => hasSalaryData(uo.offer.employment_types));
    if (has_learning_skills_goals === 'true') {
      const { learningGoals } = await loadClientProfile(clientId);
      if (learningGoals.length > 0) {
        filtered = filtered.filter(uo =>
          uo.claude_missing_skills.some(sk =>
            learningGoals.includes(sk.toLowerCase()),
          ),
        );
      }
    }
    return res.json({ count: filtered.length });
  }

  // count_only=true for non-ai_rejected statuses: pure DB count, no data transfer
  if (count_only === 'true') {
    const count = await prisma.userOffer.count({ where });
    return res.json({ count });
  }

  const userOffers = await prisma.userOffer.findMany({
    where,
    include: {
      offer: {
        select: {
          title: true,
          company_name: true,
          url: true,
          employment_types: true,
          source: true,
          city: true,
          workplace_type: true,
          experience_level: true,
          working_time: true,
          required_skills: true,
          nice_to_have_skills: true,
        },
      },
      status_history: {
        where: { status: 'applied' },
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
    orderBy: sortBy === 'salary_delta'
      ? [{ salary_delta: { sort: 'desc', nulls: 'last' } }, { claude_score: 'desc' }]
      : [{ claude_score: 'desc' }],
  });

  const [{ learningGoals }, pageSizeSetting, dbUser, exchangeRatesSetting] = await Promise.all([
    loadClientProfile(clientId),
    prisma.settings.findUnique({ where: { key: 'listing_offers_page_size' } }),
    prisma.user.findUnique({
      where: { id: clientId },
      select: { preferred_currency: true, profile: true },
    }),
    prisma.settings.findUnique({ where: { key: 'exchange_rates' } }),
  ]);
  const preferredCurrency = dbUser?.preferred_currency ?? 'USD';
  const exchangeRates: Record<string, number> = exchangeRatesSetting
    ? (JSON.parse(exchangeRatesSetting.value) as Record<string, number>)
    : {};
  const rawProfile = dbUser?.profile as { preferences?: { salary?: Array<{ type: string; currency: string; min: number; unit?: string }> } } | null;
  const salaryPrefs = (rawProfile?.preferences?.salary ?? []).map(p => ({
    type: p.type,
    currency: p.currency,
    min: p.min,
    unit: p.unit,
  }));
  const pageSize = parseInt(pageSizeSetting?.value ?? '10', 10) || 10;
  const start = (page - 1) * pageSize;

  // Dedup: one row per unique offer fingerprint; prefer highest claude_score, then most recent matched_at
  const seen = new Map<string, (typeof userOffers)[number]>();
  for (const uo of userOffers) {
    const key = dedupKey(uo.offer);
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, uo);
    } else {
      const prevScore = prev.claude_score ?? -1;
      const newScore = uo.claude_score ?? -1;
      if (
        newScore > prevScore ||
        (newScore === prevScore && uo.matched_at > prev.matched_at)
      ) {
        seen.set(key, uo);
      }
    }
  }

  let result = [...seen.values()];

  if (status === 'ai_rejected') {
    result = result.filter(uo => hasSalaryData(uo.offer.employment_types));
    if (has_learning_skills_goals === 'true' && learningGoals.length > 0) {
      result = result.filter(uo =>
        uo.claude_missing_skills.some(sk =>
          learningGoals.includes(sk.toLowerCase()),
        ),
      );
    }
  }

  const mapped = result.map(uo => {
    const salaryResult = calculateUserOfferSalary(
      Array.isArray(uo.offer.employment_types) ? uo.offer.employment_types : [],
      preferredCurrency,
      salaryPrefs,
      exchangeRates,
    );
    return {
      user_offer_id: uo.id,
      offer_id: uo.offer_id,
      offer_title: uo.offer.title,
      offer_company: uo.offer.company_name,
      offer_url: uo.offer.url,
      claude_score: uo.claude_score,
      claude_role_fit: uo.claude_role_fit,
      claude_matched_reasons: uo.claude_matched_reasons,
      claude_missing_skills: uo.claude_missing_skills,
      claude_recommended: uo.claude_recommended,
      rejection_reason: uo.rejection_reason,
      matched_at: uo.matched_at,
      applied_at: uo.status_history[0]?.created_at ?? null,
      salary: salaryResult
        ? [{ min: salaryResult.salary_min, max: salaryResult.salary_max, currency: salaryResult.salary_currency, delta: salaryResult.salary_delta, type: salaryResult.salary_type ?? '' }]
        : [],
      salary_delta: uo.salary_delta,
      raw_salaries: Array.isArray(uo.offer.employment_types)
        ? (uo.offer.employment_types as Array<Record<string, unknown>>).map(et => ({
            from: et['fromPerUnit'] ?? et['from'] ?? null,
            to: et['toPerUnit'] ?? et['to'] ?? null,
            currency: et['currency'] ?? null,
            unit: et['unit'] ?? null,
            type: et['type'] ?? null,
          }))
        : [],
      source: uo.offer.source,
      city: uo.offer.city ?? null,
      work_model: uo.offer.workplace_type ?? null,
      required_skills: uo.offer.required_skills,
      nice_to_have_skills: uo.offer.nice_to_have_skills,
      cv_language: uo.cv_language,
      cv_status: uo.cv_status ?? null,
      cv_url: uo.cv_url ?? null,
      cl_status: uo.cl_status ?? null,
      cl_url: uo.cl_url ?? null,
      status: uo.status,
    };
  });

  const finalMapped = status === 'ai_rejected'
    ? mapped.filter(o => o.salary.length > 0)
    : mapped;

  const apply_now_count = finalMapped.filter(
    o => o.claude_recommended === true,
  ).length;
  const level_up_count = finalMapped.filter(
    o => o.claude_recommended === false,
  ).length;

  let filtered = finalMapped;

  // Apply plan limits for pending_apply (client only; agent sees all)
  if (role === 'client' && status === 'pending_apply') {
    const subscription = await prisma.subscription.findUnique({
      where: { user_id: clientId },
      include: { plan: true },
    });
    const effectivePlan =
      subscription?.plan ??
      (await prisma.plan.findUnique({ where: { name: 'free' } }));
    const limits = effectivePlan?.limits as {
      max_apply_now: number | null;
      max_level_up: number | null;
    } | null;

    if (
      limits != null &&
      (limits.max_apply_now !== null || limits.max_level_up !== null)
    ) {
      const byScoreAndDelta = (
        a: (typeof mapped)[number],
        b: (typeof mapped)[number],
      ) =>
        (b.claude_score ?? 0) - (a.claude_score ?? 0) ||
        (b.salary_delta ?? -Infinity) - (a.salary_delta ?? -Infinity);

      const applyNow = filtered
        .filter(o => o.claude_recommended === true)
        .sort(byScoreAndDelta);
      const levelUp = filtered
        .filter(o => o.claude_recommended === false)
        .sort(byScoreAndDelta);

      const limitedApplyNow =
        limits.max_apply_now != null
          ? applyNow.slice(0, limits.max_apply_now)
          : applyNow;
      const limitedLevelUp =
        limits.max_level_up != null
          ? levelUp.slice(0, limits.max_level_up)
          : levelUp;

      filtered = [...limitedApplyNow, ...limitedLevelUp];
    }
  }

  if (date_from) {
    const from = new Date(date_from);
    filtered = filtered.filter(
      o => o.applied_at != null && new Date(o.applied_at) >= from,
    );
  }
  if (date_to) {
    const to = new Date(date_to);
    filtered = filtered.filter(
      o => o.applied_at != null && new Date(o.applied_at) <= to,
    );
  }

  filtered = [...filtered].sort((a, b) => {
    if (sortBy === 'salary_delta') {
      const da = a.salary_delta
      const db = b.salary_delta
      if (da !== db) {
        if (da === null) return 1
        if (db === null) return -1
        return db - da
      }
    }
    const scoreDiff = (b.claude_score ?? 0) - (a.claude_score ?? 0)
    if (scoreDiff !== 0) return scoreDiff
    return (a.work_model === 'remote' ? 0 : 1) - (b.work_model === 'remote' ? 0 : 1)
  })

  const pagedOffers = filtered.slice(start, start + pageSize);
  const has_more = filtered.length > start + pageSize;

  res.json({
    client_id: clientId,
    status,
    count: mapped.length,
    apply_now_count,
    level_up_count,
    has_more,
    offers: pagedOffers,
  });
});
