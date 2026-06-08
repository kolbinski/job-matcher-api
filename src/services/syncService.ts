import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { runMatchForUser } from './matchService';
import { buildEmailReport } from './emailReport';
import { buildSyncReport, type SalaryPref } from './syncReport';
import { sendMatchReport } from './emailService';

const isTestUser = (email: string): boolean =>
  email.includes('test') ||
  email.includes('@jobmatche') ||
  email.includes('@jobmatcl') ||
  email.endsWith('.test');

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

  job.total_clients = users.length;
  console.log(`[sync] Starting job for ${users.length} users`);

  // Exchange rates are constant for the entire job run — load once
  let exchangeRates: Record<string, number> = {}
  try {
    const ratesSetting = await prisma.settings.findUnique({ where: { key: 'exchange_rates' } })
    if (ratesSetting) exchangeRates = JSON.parse(ratesSetting.value) as Record<string, number>
  } catch { /* rates stay empty — delta_normalized will equal delta */ }

  for (const user of users) {
    const milestone = ((job.processed_clients + 1) / job.total_clients) * 100;
    const easeInterval = setInterval(() => {
      job.progress = Math.round(
        job.progress + (milestone - job.progress) * 0.1,
      );
    }, 15_000);

    try {
      const result = await runMatchForUser(user.id, { ai_scoring: true });

      const newOffersCount = result.matched.filter(
        o => o.recommended === true,
      ).length;
      const stretchCount = result.stretch_offers.length;
      const email_report = buildEmailReport(result, user);

      const rawProfile = (user.profile as unknown) as {
        preferences?: { salary?: Array<{ type?: string; currency?: string; min?: number }> }
      }
      const salaryPrefs: SalaryPref[] = (rawProfile?.preferences?.salary ?? [])
        .filter((p): p is SalaryPref => p.type != null && p.currency != null && p.min != null)

      const syncReport = buildSyncReport(result, salaryPrefs, exchangeRates);
      await prisma.userSync.create({
        data: { user_id: user.id, report: syncReport as unknown as Prisma.InputJsonValue },
      });

      if (user.email) {
        if (isTestUser(user.email)) {
          console.log(`[sync] Skipping email for test user: ${user.email}`);
        } else {
          await sendMatchReport(agentEmail, agentName, user.email, email_report);
          console.log(`[sync] Email sent to ${user.email}`);
        }
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
