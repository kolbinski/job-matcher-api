import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { validateJwt } from '../middleware/validateJwt';
import { dedupeUserOffers } from '../utils/deduplicateOffers';
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
  min_score: z.coerce.number().int().min(0).optional(),
  generated_cv: z.enum(['true', 'false']).optional(),
  generated_cl: z.enum(['true', 'false']).optional(),
  sort_by: z.enum(['score', 'salary_delta', 'published_at']).optional(),
  known_apply_count: z.coerce.number().int().min(0).optional(),
  known_level_up_count: z.coerce.number().int().min(0).optional(),
  known_new_skills_count: z.coerce.number().int().min(0).optional(),
  with_salary: z.enum(['true', 'false']).optional(),
  is_starred: z.enum(['true', 'false']).optional(),
  page_apply_now: z.coerce.number().int().min(1).optional(),
  page_level_up: z.coerce.number().int().min(1).optional(),
  page_applied: z.coerce.number().int().min(1).optional(),
  page_client_withdrawn: z.coerce.number().int().min(1).optional(),
  page_recruiter_rejected: z.coerce.number().int().min(1).optional(),
  page_offer_received: z.coerce.number().int().min(1).optional(),
  page_accepted: z.coerce.number().int().min(1).optional(),
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

const STATUS_KEY: Record<string, string> = {
  pending_apply: 'apply_now',
  ai_rejected: 'level_up',
  applied: 'applied',
  client_withdrawn: 'client_withdrawn',
  recruiter_rejected: 'recruiter_rejected',
  offer_received: 'offer_received',
  accepted: 'accepted',
}

const ALL_STATUSES = [
  'pending_apply', 'ai_rejected', 'applied', 'client_withdrawn',
  'recruiter_rejected', 'offer_received', 'accepted',
]

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
      missing_skills: uo.missing_skills,
      claude_recommended: uo.claude_recommended,
      rejection_reason: uo.rejection_reason,
      matched_at: uo.matched_at,
      applied_at: uo.status_history[0]?.created_at ?? null,
      salary: [
        ...(salaryResult?.contract ? [{ min: salaryResult.contract.min, max: salaryResult.contract.max, currency: salaryResult.salary_currency, delta: salaryResult.contract.delta, type: 'contract' }] : []),
        ...(salaryResult?.permanent ? [{ min: salaryResult.permanent.min, max: salaryResult.permanent.max, currency: salaryResult.salary_currency, delta: salaryResult.permanent.delta, type: 'permanent' }] : []),
      ],
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

userOffersRouter.patch('/:id/star', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const { id } = req.params as { id: string }
  const userOffer = await prisma.userOffer.findFirst({ where: { id, user_id: user_id! } })
  if (!userOffer) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'User offer not found or does not belong to you' })
  }
  const updated = await prisma.userOffer.update({
    where: { id },
    data: { is_starred: !userOffer.is_starred },
    select: { is_starred: true },
  })
  return res.json({ is_starred: updated.is_starred })
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
  const parsed = QuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(422).json({
      error: 'INVALID_REQUEST',
      message: 'Missing required query param: status',
      issues: parsed.error.issues,
    })
  }

  const {
    status,
    has_learning_skills_goals,
    count_only,
    source,
    date_from,
    date_to,
    min_score: minScoreParam,
    generated_cv,
    generated_cl,
    sort_by: sortBy,
    known_apply_count: knownApplyCount,
    known_level_up_count: knownLevelUpCount,
    with_salary,
    is_starred: isStarredFilter,
    page_apply_now,
    page_level_up,
    page_applied,
    page_client_withdrawn,
    page_recruiter_rejected,
    page_offer_received,
    page_accepted,
  } = parsed.data
  const minScore = minScoreParam ?? 0

  const { role, agent_id, user_id } = req.jwt!

  let clientId: string

  if (role === 'client') {
    clientId = user_id!
  } else {
    if (!parsed.data.client_id) {
      return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Missing required query param: client_id' })
    }
    clientId = parsed.data.client_id
    const agentClient = await prisma.agentClient.findUnique({
      where: { agent_id_user_id: { agent_id: agent_id!, user_id: clientId } },
    })
    if (!agentClient) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Client not linked to this agent' })
    }
  }

  const statuses = status === 'all'
    ? ALL_STATUSES
    : status.split('|').map(s => s.trim()).filter(Boolean)

  const pageForStatus = (s: string): number => {
    const pageMap: Record<string, number | undefined> = {
      apply_now: page_apply_now,
      level_up: page_level_up,
      applied: page_applied,
      client_withdrawn: page_client_withdrawn,
      recruiter_rejected: page_recruiter_rejected,
      offer_received: page_offer_received,
      accepted: page_accepted,
    }
    return pageMap[STATUS_KEY[s] ?? s] ?? 1
  }

  // ── Legacy count_only — single-status early return ─────────────────────────
  if (count_only === 'true' && statuses.length === 1) {
    const singleStatus = statuses[0]!
    const offerWhere = { ...(source && source !== 'all' ? { source } : {}) }
    const isScoreStatus = singleStatus === 'pending_apply' || singleStatus === 'ai_rejected'
    const where = {
      user_id: clientId,
      status: singleStatus,
      ...(isScoreStatus && minScore > 0 ? { claude_score: { gte: minScore } } : {}),
      ...(Object.keys(offerWhere).length > 0 ? { offer: offerWhere } : {}),
    }
    if (singleStatus === 'ai_rejected') {
      const rows = await prisma.userOffer.findMany({
        where,
        select: { missing_skills: true, offer: { select: { employment_types: true } } },
      })
      let countFiltered = rows.filter(uo => hasSalaryData(uo.offer.employment_types))
      if (has_learning_skills_goals === 'true') {
        const { learningGoals } = await loadClientProfile(clientId)
        if (learningGoals.length > 0) {
          countFiltered = countFiltered.filter(uo => uo.missing_skills.some(sk => learningGoals.includes(sk.toLowerCase())))
        }
      }
      return res.json({ count: countFiltered.length })
    }
    const count = await prisma.userOffer.count({ where })
    return res.json({ count })
  }

  // ── Load shared data ────────────────────────────────────────────────────────
  {
    const [{ learningGoals }, subscription, pageSizeSetting, dbUser, exchangeRatesSetting, dedupSourcePrefSetting] =
      await Promise.all([
        loadClientProfile(clientId),
        role === 'client'
          ? prisma.subscription.findUnique({ where: { user_id: clientId }, include: { plan: true } })
          : Promise.resolve(null),
        prisma.settings.findUnique({ where: { key: 'listing_offers_page_size' } }),
        prisma.user.findUnique({ where: { id: clientId }, select: { preferred_currency: true, profile: true, offer_skills: true } }),
        prisma.settings.findUnique({ where: { key: 'exchange_rates' } }),
        prisma.settings.findUnique({ where: { key: 'dedup_source_preference' } }),
      ])
    const preferredCurrency = dbUser?.preferred_currency ?? 'USD';
    const exchangeRates: Record<string, number> = exchangeRatesSetting
      ? (JSON.parse(exchangeRatesSetting.value) as Record<string, number>)
      : {}
    const rawProfile = dbUser?.profile as { preferences?: { salary?: Array<{ type: string; currency: string; min: number; unit?: string }>; work_model?: string[]; office_location_cities?: string[] } } | null
    const salaryPrefs = (rawProfile?.preferences?.salary ?? []).map(p => ({ type: p.type, currency: p.currency, min: p.min, unit: p.unit }))
    const userWorkModel = (rawProfile?.preferences?.work_model ?? []).map(m => m.toLowerCase())
    const userOfficeCities = rawProfile?.preferences?.office_location_cities ?? []
    const preferredSource = dedupSourcePrefSetting ? (JSON.parse(dedupSourcePrefSetting.value) as string) : undefined
    interface OfferSkillEntry { name: string; count: number; category_name: string; dismissed: boolean }
    const new_skills_count = ((dbUser?.offer_skills ?? []) as unknown as OfferSkillEntry[]).filter(s => !s.dismissed).length
    const pageSize = parseInt(pageSizeSetting?.value ?? '10', 10) || 10
    const effectivePlan = subscription?.plan ?? (role === 'client' ? await prisma.plan.findUnique({ where: { name: 'free' } }) : null)
    const planLimits = effectivePlan?.limits as { max_apply_now: number | null; max_level_up: number | null } | null


    const offerSelect = {
      title: true, company_name: true, url: true, employment_types: true,
      source: true, city: true, workplace_type: true, experience_level: true,
      working_time: true, required_skills: true, nice_to_have_skills: true, published_at: true,
    } as const

    // ── Free plan snapshot (pending_apply|ai_rejected two-section view only) ──
    const isDefaultView = statuses.length === 2 && statuses.includes('pending_apply') && statuses.includes('ai_rejected')
    if (role === 'client' && effectivePlan?.name === 'free' && isDefaultView) {
      const userWithSnapshot = await prisma.user.findUnique({
        where: { id: clientId },
        select: { free_plan_snapshot: true },
      })
      const snapshotExists = userWithSnapshot?.free_plan_snapshot != null
      if (!snapshotExists) {
        console.log(`[snapshot] exists: false — falling through to live DB path`)
      }
      if (snapshotExists) {
        const snap = userWithSnapshot!.free_plan_snapshot as {
          apply_now?: { count: number; offers: unknown[] }
          level_up?: { count: number; offers: unknown[] }
        }
        const snapApplyNow = (snap.apply_now?.offers ?? []) as Array<Record<string, unknown>>
        const snapLevelUp = (snap.level_up?.offers ?? []) as Array<Record<string, unknown>>

        // DB-level base WHERE for count queries (no plan limits)
        const applyNowBaseWhere = {
          user_id: clientId,
          status: 'pending_apply',
          ...(minScore > 0 ? { claude_score: { gte: minScore } } : {}),
        }
        const levelUpBaseWhere = {
          user_id: clientId,
          status: 'ai_rejected',
          missing_skills: { isEmpty: false },
          OR: [{ salary_contract_delta: { not: null } }, { salary_permanent_delta: { not: null } }],
        }
        // User-level filter conditions translated to DB predicates
        const userAndConditions = [
          ...(with_salary === 'true' ? [{ OR: [{ salary_contract_delta: { not: null } }, { salary_permanent_delta: { not: null } }] }] : []),
          ...(isStarredFilter === 'true' ? [{ is_starred: true as const }] : []),
          ...(generated_cv === 'true' ? [{ cv_status: 'done' }] : []),
          ...(generated_cl === 'true' ? [{ cl_status: 'done' }] : []),
        ]
        const applyNowFilterWhere = userAndConditions.length > 0 ? { ...applyNowBaseWhere, AND: userAndConditions } : applyNowBaseWhere
        const levelUpFilterWhere = userAndConditions.length > 0 ? { ...levelUpBaseWhere, AND: userAndConditions } : levelUpBaseWhere

        const allSnapIds = [...snapApplyNow, ...snapLevelUp]
          .map(o => o['user_offer_id'] as string).filter(Boolean)
        const [starredRows, countAN, countAfterFiltersAN, countLU, countAfterFiltersLU] = await Promise.all([
          prisma.userOffer.findMany({
            where: { id: { in: allSnapIds } },
            select: { id: true, is_starred: true },
          }),
          prisma.userOffer.count({ where: applyNowBaseWhere }),
          prisma.userOffer.count({ where: applyNowFilterWhere }),
          prisma.userOffer.count({ where: levelUpBaseWhere }),
          prisma.userOffer.count({ where: levelUpFilterWhere }),
        ])

        const isStarredMap: Record<string, boolean> = {}
        for (const r of starredRows) { isStarredMap[r.id] = r.is_starred }

        const enrichSnap = (offers: Array<Record<string, unknown>>) =>
          offers.map(o => ({ ...o, is_starred: isStarredMap[o['user_offer_id'] as string] ?? false }))

        const filterSnap = (offers: Array<Record<string, unknown>>, applyMinScore: boolean): Array<Record<string, unknown>> => {
          let arr = offers
          if (applyMinScore && minScore > 0) arr = arr.filter(o => ((o['claude_score'] as number | null) ?? 0) >= minScore)
          if (with_salary === 'true') arr = arr.filter(o => Array.isArray(o['salary']) && (o['salary'] as unknown[]).length > 0)
          if (isStarredFilter === 'true') arr = arr.filter(o => o['is_starred'] === true)
          if (generated_cv === 'true') arr = arr.filter(o => o['cv_status'] === 'done')
          if (generated_cl === 'true') arr = arr.filter(o => o['cl_status'] === 'done')
          return arr
        }

        const filteredApplyNow = filterSnap(enrichSnap(snapApplyNow), true)
        const filteredLevelUp = filterSnap(enrichSnap(snapLevelUp), false)
        const pageAN = page_apply_now ?? 1
        const pageLU = page_level_up ?? 1
        const startAN = (pageAN - 1) * pageSize
        const startLU = (pageLU - 1) * pageSize

        console.log(`[snapshot] exists: true, apply_now length: ${snapApplyNow.length}, level_up length: ${snapLevelUp.length}, page_apply_now: ${pageAN}, offset: ${startAN}, countAN: ${countAN}, countLU: ${countLU}`)

        // Stale snapshot: has no offers but DB has items — fall through to live path so
        // the user sees real results instead of empty offers.
        if (snapApplyNow.length === 0 && snapLevelUp.length === 0 && (countAN > 0 || countLU > 0)) {
          console.log(`[snapshot] stale (empty offers but DB has apply_now=${countAN}, level_up=${countLU}), falling through to live DB path`)
        } else {
          let applyNow = {
            count: countAN,
            count_after_filters: countAfterFiltersAN,
            has_more: filteredApplyNow.length > startAN + pageSize,
            offers: filteredApplyNow.slice(startAN, startAN + pageSize),
          }
          let levelUp = {
            count: countLU,
            count_after_filters: countAfterFiltersLU,
            has_more: filteredLevelUp.length > startLU + pageSize,
            offers: filteredLevelUp.slice(startLU, startLU + pageSize),
          }

          if (knownApplyCount !== undefined && knownApplyCount === countAN && pageAN === 1) applyNow = { ...applyNow, offers: [] }
          if (knownLevelUpCount !== undefined && knownLevelUpCount === countLU && pageLU === 1) levelUp = { ...levelUp, offers: [] }

          return res.json({ client_id: clientId, new_skills_count, apply_now: applyNow, level_up: levelUp })
        }
      }
    }

    // ── Build sections from live DB ─────────────────────────────────────────────
    const sections: Record<string, { count: number; count_after_filters: number; has_more: boolean; offers: unknown[] }> = {}

    for (const bucketStatus of statuses) {
      const page = pageForStatus(bucketStatus)
      const start = (page - 1) * pageSize
      const sectionKey = STATUS_KEY[bucketStatus] ?? bucketStatus
      const offerWhere = { ...(source && source !== 'all' ? { source } : {}) }

      const bucketWhere = {
        user_id: clientId,
        status: bucketStatus,
        ...(bucketStatus === 'ai_rejected'
          ? { missing_skills: { isEmpty: false }, OR: [{ salary_contract_delta: { not: null } }, { salary_permanent_delta: { not: null } }] }
          : {}),
        ...(bucketStatus === 'pending_apply' && minScore > 0 ? { claude_score: { gte: minScore } } : {}),
        ...(Object.keys(offerWhere).length > 0 ? { offer: offerWhere } : {}),
      }

      const rows = await prisma.userOffer.findMany({
        where: bucketWhere,
        include: {
          offer: { select: offerSelect },
          status_history: { where: { status: 'applied' }, orderBy: { created_at: 'desc' }, take: 1 },
        },
        orderBy: sortBy === 'salary_delta'
          ? [{ salary_contract_delta: { sort: 'desc', nulls: 'last' } }, { salary_permanent_delta: { sort: 'desc', nulls: 'last' } }, { claude_score: 'desc' }]
          : sortBy === 'published_at'
          ? [{ offer: { published_at: 'desc' } }]
          : [{ claude_score: 'desc' }],
      })

      const deduped = (bucketStatus === 'pending_apply' || bucketStatus === 'ai_rejected')
        ? dedupeUserOffers(rows, preferredSource, userWorkModel, userOfficeCities)
        : rows

      // Per-status base filter: learning goals for ai_rejected (affects count, not count_after_filters)
      let baseFiltered = deduped as typeof rows
      if (bucketStatus === 'ai_rejected' && learningGoals.length > 0) {
        baseFiltered = deduped.filter(uo => uo.missing_skills.some(sk => learningGoals.includes(sk.toLowerCase()))) as typeof rows
      }

      const mapped = baseFiltered.map(uo => {
        const salaryResult = calculateUserOfferSalary(
          Array.isArray(uo.offer.employment_types) ? uo.offer.employment_types : [],
          preferredCurrency, salaryPrefs, exchangeRates,
        )
        return {
          user_offer_id: uo.id,
          offer_id: uo.offer_id,
          offer_title: uo.offer.title,
          offer_company: uo.offer.company_name,
          offer_url: uo.offer.url,
          claude_score: uo.claude_score,
          claude_role_fit: uo.claude_role_fit,
          claude_matched_reasons: uo.claude_matched_reasons,
          missing_skills: uo.missing_skills,
          claude_recommended: uo.claude_recommended,
          rejection_reason: uo.rejection_reason,
          matched_at: uo.matched_at,
          applied_at: uo.status_history[0]?.created_at ?? null,
          salary: [
            ...(salaryResult?.contract ? [{ min: salaryResult.contract.min, max: salaryResult.contract.max, currency: salaryResult.salary_currency, delta: salaryResult.contract.delta, type: 'contract' }] : []),
            ...(salaryResult?.permanent ? [{ min: salaryResult.permanent.min, max: salaryResult.permanent.max, currency: salaryResult.salary_currency, delta: salaryResult.permanent.delta, type: 'permanent' }] : []),
          ],
          salary_delta: Math.max(salaryResult?.contract?.delta ?? -Infinity, salaryResult?.permanent?.delta ?? -Infinity),
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
          published_at: uo.offer.published_at ?? null,
          is_starred: uo.is_starred,
          cv_language: uo.cv_language,
          cv_status: uo.cv_status ?? null,
          cv_url: uo.cv_url ?? null,
          cl_status: uo.cl_status ?? null,
          cl_url: uo.cl_url ?? null,
          status: uo.status,
        }
      })

      const count = mapped.length

      // User-level filters (affect count_after_filters, not count)
      let userFiltered = mapped as typeof mapped
      if (with_salary === 'true') userFiltered = userFiltered.filter(o => o.salary.length > 0)
      if (isStarredFilter === 'true') userFiltered = userFiltered.filter(o => o.is_starred)
      if (generated_cv === 'true') userFiltered = userFiltered.filter(o => o.cv_status === 'done')
      if (generated_cl === 'true') userFiltered = userFiltered.filter(o => o.cl_status === 'done')
      if (bucketStatus === 'applied') {
        if (date_from) {
          const from = new Date(date_from)
          userFiltered = userFiltered.filter(o => o.applied_at != null && new Date(o.applied_at) >= from)
        }
        if (date_to) {
          const to = new Date(date_to)
          userFiltered = userFiltered.filter(o => o.applied_at != null && new Date(o.applied_at) <= to)
        }
      }

      const count_after_filters = userFiltered.length

      // Plan limits (pending_apply and ai_rejected only)
      let limited = userFiltered
      if (role === 'client' && planLimits != null) {
        const byScoreAndDelta = (a: typeof mapped[0], b: typeof mapped[0]) =>
          (b.claude_score ?? 0) - (a.claude_score ?? 0) ||
          (b.salary_delta ?? -Infinity) - (a.salary_delta ?? -Infinity)
        if (bucketStatus === 'pending_apply' && planLimits.max_apply_now != null) {
          limited = [...userFiltered].sort(byScoreAndDelta).slice(0, planLimits.max_apply_now)
        } else if (bucketStatus === 'ai_rejected' && planLimits.max_level_up != null) {
          limited = [...userFiltered].sort(byScoreAndDelta).slice(0, planLimits.max_level_up)
        }
      }

      // Final sort + paginate
      const sorted = [...limited].sort((a, b) => {
        if (sortBy === 'salary_delta') {
          const da = a.salary_delta, db = b.salary_delta
          if (da !== db) {
            if (da === -Infinity) return 1
            if (db === -Infinity) return -1
            return db - da
          }
        }
        if (sortBy === 'published_at') {
          const da = a.published_at ? new Date(a.published_at).getTime() : 0
          const db = b.published_at ? new Date(b.published_at).getTime() : 0
          if (da !== db) return db - da
        }
        const scoreDiff = (b.claude_score ?? 0) - (a.claude_score ?? 0)
        if (scoreDiff !== 0) return scoreDiff
        return (a.work_model === 'remote' ? 0 : 1) - (b.work_model === 'remote' ? 0 : 1)
      })

      sections[sectionKey] = {
        count,
        count_after_filters,
        has_more: limited.length > start + pageSize,
        offers: sorted.slice(start, start + pageSize),
      }
    }

    if (knownApplyCount !== undefined && sections['apply_now'] && knownApplyCount === sections['apply_now'].count && (page_apply_now ?? 1) === 1) {
      sections['apply_now'] = { ...sections['apply_now'], offers: [] }
    }
    if (knownLevelUpCount !== undefined && sections['level_up'] && knownLevelUpCount === sections['level_up'].count && (page_level_up ?? 1) === 1) {
      sections['level_up'] = { ...sections['level_up'], offers: [] }
    }

    return res.json({ client_id: clientId, new_skills_count, ...sections })
  }
});
