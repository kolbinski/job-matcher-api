import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { runMatchForUser } from './matchService';
import { buildEmailReport } from './emailReport';
import { buildSyncReport, type SalaryPref } from './syncReport';
import { deduplicateMatchResult, dedupeUserOffers } from '../utils/deduplicateOffers';
// import { sendMatchReport } from './emailService';

// const isTestUser = (email: string): boolean =>
//   email.includes('test') ||
//   email.includes('@jobmatche') ||
//   email.includes('@jobmatcl') ||
//   email.endsWith('.test');

export async function sendPushToClient(
  userId: string,
  title: string,
  body: string,
  data: Record<string, string> = {},
): Promise<void> {
  const tokens = await prisma.pushToken.findMany({
    where: { user_id: userId },
    select: { token: true },
  });
  if (tokens.length === 0) return;

  const messages = tokens.map(pt => ({
    to: pt.token,
    title,
    body,
    data,
  }));

  console.log('[push] Sending to tokens:', tokens.length);
  for (const pt of tokens) {
    console.log('[push] Token:', pt.token.substring(0, 30) + '...');
  }

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  const result = await response.json();
  console.log('[push] Body', body, '; Expo response:', JSON.stringify(result));
}

interface SyncClientResult {
  client_id: string;
  first_name: string | null;
  last_name: string | null;
  new_offers_count: number;
  stretch_offers_count: number;
  email_report: string;
  email_sent: boolean;
  error?: string;
}

export interface SyncJob {
  status: 'running' | 'done' | 'error';
  started_at: string;
  finished_at?: string;
  progress: number;
  total_clients: number;
  processed_clients: number;
  total_new_offers: number;
  total_offers_scanned: number;
  clients: SyncClientResult[];
}

const jobs = new Map<string, SyncJob>();

export function getJob(jobId: string): SyncJob | undefined {
  return jobs.get(jobId);
}

export function startSyncJob(
  agentId: string,
  agentEmail: string,
  agentName: string,
): string {
  const jobId = randomUUID();
  const job: SyncJob = {
    status: 'running',
    started_at: new Date().toISOString(),
    progress: 0,
    total_clients: 0,
    processed_clients: 0,
    total_new_offers: 0,
    total_offers_scanned: 0,
    clients: [],
  };
  jobs.set(jobId, job);

  runJob(job, agentId, agentEmail, agentName).catch(err => {
    job.status = 'error';
    job.finished_at = new Date().toISOString();
    console.error(
      '[syncService] runJob failed:',
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err.stack : '',
    );
  });

  return jobId;
}

async function runJob(
  job: SyncJob,
  agentId: string,
  agentEmail: string,
  agentName: string,
): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      profile: { not: Prisma.DbNull },
      agent_clients: { some: { agent_id: agentId } },
    },
    select: {
      id: true,
      email: true,
      profile: true,
    },
  });

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { first_name: true },
  });

  job.total_clients = users.length;
  console.log(`[sync] Starting job for ${users.length} users`);

  // Settings that are constant for the entire job run — load once
  let exchangeRates: Record<string, number> = {};
  try {
    const ratesSetting = await prisma.settings.findUnique({
      where: { key: 'exchange_rates' },
    });
    if (ratesSetting)
      exchangeRates = JSON.parse(ratesSetting.value) as Record<string, number>;
  } catch {
    /* rates stay empty — delta_normalized will equal delta */
  }

  const maxLevelUpSetting = await prisma.settings.findUnique({
    where: { key: 'max_level_up' },
  });
  const maxLevelUp = parseInt(maxLevelUpSetting?.value ?? '40', 10);

  for (const user of users) {
    const milestone = ((job.processed_clients + 1) / job.total_clients) * 100;
    const easeInterval = setInterval(() => {
      job.progress = Math.round(
        job.progress + (milestone - job.progress) * 0.1,
      );
    }, 15_000);

    try {
      const result = await runMatchForUser(user.id, { ai_scoring: true });

      const newOffersCount = result.meta.newly_inserted;
      const stretchCount = result.stretch_offers.length;
      const email_report = buildEmailReport(result, user);

      const rawProfile = user.profile as unknown as {
        preferences?: {
          salary?: Array<{ type?: string; currency?: string; min?: number }>;
        };
      };
      const salaryPrefs: SalaryPref[] = (
        rawProfile?.preferences?.salary ?? []
      ).filter(
        (p): p is SalaryPref =>
          p.type != null && p.currency != null && p.min != null,
      );

      const dedupedResult = deduplicateMatchResult(result);
      const syncReport = buildSyncReport(dedupedResult, salaryPrefs, exchangeRates, maxLevelUp);
      const userStillExists = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true } });
      if (!userStillExists) {
        console.log(`[sync] User ${user.id} deleted during sync, skipping userSync write`);
      } else {
        const userSync = await prisma.userSync.create({
          data: {
            user_id: user.id,
            report: syncReport as unknown as Prisma.InputJsonValue,
          },
        });

        // if (user.email) {
        //   if (isTestUser(user.email)) {
        //     console.log(`[sync] Skipping email for test user: ${user.email}`);
        //   } else {
        //     await sendMatchReport(agentEmail, agentName, user.email, email_report);
        //     console.log(`[sync] Email sent to ${user.email}`);
        //   }
        // }

        if (newOffersCount > 0 || stretchCount > 0) {
          const agentFirstName = agent?.first_name ?? agentName;
          const pushBody = `Your agent ${agentFirstName} scanned ${result.meta.total_offers_scanned} new offers. ${syncReport.worth_applying.length} are worth applying and ${syncReport.level_up.length} look promising for level up.`;
          await sendPushToClient(user.id, 'Homo Digital', pushBody, {
            type: 'sync_complete',
            user_sync_id: userSync.id,
          });
        }
      }

      const up = user.profile as { basic_info?: { first_name?: string; last_name?: string } } | null
      job.clients.push({
        client_id: user.id,
        first_name: up?.basic_info?.first_name ?? null,
        last_name: up?.basic_info?.last_name ?? null,
        new_offers_count: newOffersCount,
        stretch_offers_count: stretchCount,
        email_report,
        email_sent: !!user.email,
      });
      job.total_new_offers += newOffersCount + stretchCount;
      job.total_offers_scanned += result.meta.total_offers_scanned;

      console.log(
        `[sync] ${user.email}: ${newOffersCount} new offers, ${stretchCount} stretch, ${result.meta.total_offers_scanned} scanned`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sync] ${user.email}: failed — ${message}`);
      const upErr = user.profile as { basic_info?: { first_name?: string; last_name?: string } } | null
      job.clients.push({
        client_id: user.id,
        first_name: upErr?.basic_info?.first_name ?? null,
        last_name: upErr?.basic_info?.last_name ?? null,
        new_offers_count: 0,
        stretch_offers_count: 0,
        email_report: `[SYNC ERROR] ${message}`,
        email_sent: false,
        error: message,
      });
    }

    clearInterval(easeInterval);
    job.processed_clients++;
    job.progress = Math.round(
      (job.processed_clients / job.total_clients) * 100,
    );
  }

  job.status = 'done';
  job.finished_at = new Date().toISOString();
  console.log(`[sync] Job done. total_new_offers=${job.total_new_offers}`);
}

export async function syncUserById(userId: string): Promise<void> {
  const lockKey = `sync:${userId}`;

  const existingLock = await prisma.notificationLock.findUnique({ where: { lock_key: lockKey } });
  if (existingLock) {
    console.log(`[sync] User ${userId}: sync already in progress, skipping`);
    return;
  }

  try {
    await prisma.notificationLock.create({ data: { lock_key: lockKey } })
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'P2002') {
      console.log(`[sync] User ${userId}: sync already in progress, skipping`)
      return
    }
    throw e
  }

  try {
    await _syncUserById(userId);
  } finally {
    await prisma.notificationLock.deleteMany({ where: { lock_key: lockKey } });
  }
}

async function _syncUserById(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, profile: true },
  });
  if (!user) {
    console.log(`[sync] User ${userId} no longer exists, aborting sync`);
    return;
  }
  console.log('[sync] Running for user:', userId, 'email:', user.email);

  const agentClient = await prisma.agentClient.findFirst({
    where: { user_id: userId },
    include: { agent: { select: { first_name: true } } },
  });
  const agentName = agentClient?.agent.first_name ?? 'Your agent';

  let exchangeRates: Record<string, number> = {};
  try {
    const ratesSetting = await prisma.settings.findUnique({ where: { key: 'exchange_rates' } });
    if (ratesSetting) exchangeRates = JSON.parse(ratesSetting.value) as Record<string, number>;
  } catch { /* rates stay empty — delta_normalized will equal delta */ }

  const maxLevelUpSetting = await prisma.settings.findUnique({ where: { key: 'max_level_up' } });
  const maxLevelUp = parseInt(maxLevelUpSetting?.value ?? '40', 10);

  const syncStartedAt = new Date()
  await prisma.user.update({ where: { id: userId }, data: { sync_started_at: syncStartedAt } })

  const result = await runMatchForUser(userId, { ai_scoring: true, syncStartedAt });

  const rawProfile = user.profile as unknown as {
    preferences?: { salary?: Array<{ type?: string; currency?: string; min?: number }> };
  };
  const salaryPrefs: SalaryPref[] = (rawProfile?.preferences?.salary ?? []).filter(
    (p): p is SalaryPref => p.type != null && p.currency != null && p.min != null,
  );

  const dedupedResult = deduplicateMatchResult(result);
  const syncReport = buildSyncReport(dedupedResult, salaryPrefs, exchangeRates, maxLevelUp);
  const userBeforeSync = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!userBeforeSync) {
    console.log(`[sync] User ${userId} deleted during sync, skipping userSync write`);
    return;
  }
  const userSync = await prisma.userSync.create({
    data: { user_id: userId, report: syncReport as unknown as Prisma.InputJsonValue },
  });

  const newOffersCount = result.meta.newly_inserted;
  const stretchCount = result.stretch_offers.length;

  if (newOffersCount > 0 || stretchCount > 0) {
    const pushBody = `Your agent ${agentName} scanned ${result.meta.total_offers_scanned} new offers. ${syncReport.worth_applying.length} are worth applying and ${syncReport.level_up.length} look promising for level up.`;
    await sendPushToClient(userId, 'Homo Digital', pushBody, {
      type: 'sync_complete',
      user_sync_id: userSync.id,
    });
  }

  console.log(`[sync] User ${userId}: ${newOffersCount} new, ${stretchCount} stretch, ${result.meta.total_offers_scanned} scanned`);

  const userBeforeProfileSync = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!userBeforeProfileSync) {
    console.log(`[sync] User ${userId} deleted during sync, skipping profile_synced_at write`);
    return;
  }
  await prisma.user.update({
    where: { id: userId },
    data: { profile_synced_at: new Date() },
  });

  await buildAndSaveFreePlanSnapshot(userId, salaryPrefs, exchangeRates, user.profile);

  // If a re-match was requested while this sync was running, clear the flag and
  // null out profile_synced_at so the cron picks the user up for a fresh re-sync.
  const afterSync = await prisma.user.findUnique({
    where: { id: userId },
    select: { pending_rematch: true },
  });
  if (afterSync?.pending_rematch === true) {
    console.log('[sync] pending_rematch detected, queuing re-sync');
    await prisma.user.update({
      where: { id: userId },
      data: { pending_rematch: false, profile_synced_at: null },
    });
  }
}

const snapshotOfferSelect = {
  title: true, company_name: true, url: true, employment_types: true,
  source: true, city: true, workplace_type: true, required_skills: true, nice_to_have_skills: true,
  experience_level: true, working_time: true,
} as const

type SnapshotUO = {
  id: string
  claude_score: number | null
  claude_role_fit: string | null
  claude_matched_reasons: Prisma.JsonValue
  claude_missing_skills: string[]
  claude_recommended: boolean | null
  rejection_reason: string | null
  matched_at: Date
  cv_language: string | null
  cv_status: string | null
  cv_url: string | null
  cl_status: string | null
  cl_url: string | null
  status: string
  offer: {
    title: string
    company_name: string
    url: string | null
    employment_types: Prisma.JsonValue
    source: string
    city: string | null
    workplace_type: string | null
    required_skills: string[]
    nice_to_have_skills: string[]
  }
}

function buildSnapshotSalaryEntries(
  employmentTypes: Prisma.JsonValue,
  salaryPrefs: SalaryPref[],
  rates: Record<string, number>,
): Array<{ min: number; max: number; currency: string; type: string; delta: number; delta_normalized: number }> {
  if (salaryPrefs.length === 0) return []
  const types = Array.isArray(employmentTypes)
    ? (employmentTypes as Array<{ from?: number; to?: number; currency?: string; type?: string; unit?: string }>)
    : []
  const entries: ReturnType<typeof buildSnapshotSalaryEntries> = []
  for (const et of types) {
    const { from, to, currency, type: etType, unit } = et
    if (from == null || to == null || !currency || !etType) continue
    const pref = salaryPrefs.find(
      p => p.type.toLowerCase() === etType.toLowerCase() &&
           p.currency.toUpperCase() === currency.toUpperCase()
    )
    if (!pref) continue
    const effectiveTo = unit?.toLowerCase() === 'day' ? to * 20 : to
    const delta = effectiveTo - pref.min
    const rate = currency.toUpperCase() === 'PLN' ? 1 : (rates[currency.toUpperCase()] ?? 1)
    entries.push({ min: from, max: to, currency, type: etType, delta, delta_normalized: Math.round(delta * rate) })
  }
  return entries
}

function mapSnapshotOffer(uo: SnapshotUO, salaryPrefs: SalaryPref[], rates: Record<string, number>) {
  return {
    user_offer_id: uo.id,
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
    applied_at: null,
    salary: buildSnapshotSalaryEntries(uo.offer.employment_types, salaryPrefs, rates),
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
  }
}

export async function buildAndSaveFreePlanSnapshot(
  userId: string,
  salaryPrefs: SalaryPref[],
  exchangeRates: Record<string, number>,
  userProfile: Prisma.JsonValue,
): Promise<void> {
  const sub = await prisma.subscription.findFirst({
    where: { user_id: userId, status: 'active' },
    include: { plan: true },
  })
  if (sub?.plan?.name !== 'free') return

  const limits = sub.plan.limits as { max_apply_now: number | null; max_level_up: number | null } | null
  const maxApplyNow = limits?.max_apply_now ?? null
  const maxLevelUp = limits?.max_level_up ?? null

  const profile = userProfile as unknown as { preferences?: { learning_skills_goals?: string[] } } | null
  const learningGoals = (profile?.preferences?.learning_skills_goals ?? []).map(g => g.toLowerCase())

  const [allApplyNow, allLevelUpRaw] = await Promise.all([
    prisma.userOffer.findMany({
      where: { user_id: userId, status: 'pending_apply' },
      include: { offer: { select: snapshotOfferSelect } },
      orderBy: { claude_score: 'desc' },
    }),
    // level_up: not recommended (ai_rejected) + has missing skills + a computed
    // salary delta. NOTE: ai_rejected rows written before this status rule used the
    // old logic; they only get reclassified on the next re-sync (no migration).
    prisma.userOffer.findMany({
      where: { user_id: userId, status: 'ai_rejected', claude_missing_skills: { isEmpty: false }, salary_delta: { not: null } },
      include: { offer: { select: snapshotOfferSelect } },
      orderBy: { claude_score: 'desc' },
    }),
  ])

  // Dedup by offer fingerprint before counting/slicing, matching GET /v1/user-offers.
  const dedupedApplyNow = dedupeUserOffers(allApplyNow)

  const filteredLevelUp = allLevelUpRaw
    .filter(uo => learningGoals.length === 0 || uo.claude_missing_skills.some(sk => learningGoals.includes(sk.toLowerCase())))
  const dedupedLevelUp = dedupeUserOffers(filteredLevelUp)

  const applyNowOffers = maxApplyNow != null ? dedupedApplyNow.slice(0, maxApplyNow) : dedupedApplyNow
  const levelUpOffers = maxLevelUp != null ? dedupedLevelUp.slice(0, maxLevelUp) : dedupedLevelUp

  const snapshot = {
    created_at: new Date().toISOString(),
    count: dedupedApplyNow.length + dedupedLevelUp.length,
    apply_now: {
      count: dedupedApplyNow.length,
      status: 'pending_apply',
      offers: applyNowOffers.map(uo => mapSnapshotOffer(uo as unknown as SnapshotUO, salaryPrefs, exchangeRates)),
    },
    level_up: {
      count: dedupedLevelUp.length,
      status: 'ai_rejected',
      offers: levelUpOffers.map(uo => mapSnapshotOffer(uo as unknown as SnapshotUO, salaryPrefs, exchangeRates)),
    },
  }

  const userBeforeSnapshot = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!userBeforeSnapshot) {
    console.log(`[sync] User ${userId} deleted during sync, skipping free_plan_snapshot write`);
    return;
  }
  await prisma.user.update({
    where: { id: userId },
    data: { free_plan_snapshot: snapshot as unknown as Prisma.InputJsonValue },
  })

  console.log(`[sync] Built free plan snapshot for user ${userId}: ${applyNowOffers.length} apply_now, ${levelUpOffers.length} level_up`)
}
