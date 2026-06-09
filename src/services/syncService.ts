import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { runMatchForUser } from './matchService';
import { buildEmailReport } from './emailReport';
import { buildSyncReport, type SalaryPref } from './syncReport';
import { deduplicateMatchResult } from '../utils/deduplicateOffers';
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
      first_name: true,
      last_name: true,
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

      job.clients.push({
        client_id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
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
      job.clients.push({
        client_id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
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
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, first_name: true, profile: true },
  });
  if (!user) throw new Error(`syncUserById: user ${userId} not found`);

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

  const result = await runMatchForUser(userId, { ai_scoring: true });

  const rawProfile = user.profile as unknown as {
    preferences?: { salary?: Array<{ type?: string; currency?: string; min?: number }> };
  };
  const salaryPrefs: SalaryPref[] = (rawProfile?.preferences?.salary ?? []).filter(
    (p): p is SalaryPref => p.type != null && p.currency != null && p.min != null,
  );

  const dedupedResult = deduplicateMatchResult(result);
  const syncReport = buildSyncReport(dedupedResult, salaryPrefs, exchangeRates, maxLevelUp);
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
}
