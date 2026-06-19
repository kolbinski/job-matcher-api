import cron from 'node-cron';
import { prisma } from './prisma';
import { syncOffers } from '../jobs/offerSync';
import { categorizeSkills } from '../jobs/categorizeSkills';
import { sendPushToClient, syncUserById } from '../services/syncService';

const STARTUP_GRACE_MS = 60 * 1000;
const startupTime = Date.now();

let syncInProgress = false;
let categorizeInProgress = false;
const syncingUserIds = new Set<string>();

// Reads work_start_utc, work_end_utc, work_days from settings on every call
// so DB changes take effect immediately without redeploy.
async function isWithinSchedule(): Promise<boolean> {
  const [startRow, endRow, daysRow] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'work_start_utc' } }),
    prisma.settings.findUnique({ where: { key: 'work_end_utc' } }),
    prisma.settings.findUnique({ where: { key: 'work_days' } }),
  ]);

  const startHour = parseInt(startRow?.value ?? '6', 10);
  const endHour = parseInt(endRow?.value ?? '15', 10);

  // Parse 'min-max' day range, e.g. '1-5' → [1, 5]; default to Mon-Fri on invalid value
  const [rawMin, rawMax] = (daysRow?.value ?? '1-5').split('-').map(Number);
  const minDay = isNaN(rawMin) ? 1 : rawMin;
  const maxDay = isNaN(rawMax) ? 5 : rawMax;
  if (isNaN(rawMin) || isNaN(rawMax)) {
    console.error(
      `[scheduler] Invalid work_days value: "${daysRow?.value}" — defaulting to Mon-Fri (1-5)`,
    );
  }

  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

  const afterStart = hour >= startHour;
  const beforeEnd = hour <= endHour;
  return day >= minDay && day <= maxDay && afterStart && beforeEnd;
}

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

async function acquireNotificationLock(lockKey: string): Promise<boolean> {
  try {
    await prisma.notificationLock.create({ data: { lock_key: lockKey } })
    return true
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'P2002') return false
    throw e
  }
}

async function cleanupOldLocks(): Promise<void> {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await prisma.notificationLock.deleteMany({
    where: { created_at: { lt: twoDaysAgo } },
  });
}

function cetTimeString(): string {
  return new Date().toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw' });
}

async function runSync(): Promise<void> {
  if (Date.now() - startupTime < STARTUP_GRACE_MS) {
    console.log(
      '[scheduler] Skipping first tick — within 5min grace period after startup',
    );
    return;
  }
  if (syncInProgress) {
    console.log('[scheduler] Previous sync still running — skipping this tick');
    return;
  }
  syncInProgress = true;
  try {
    const withinSchedule = await isWithinSchedule();
    console.log(
      `[scheduler] Starting sync at ${cetTimeString()} (cleanup: ${withinSchedule})`,
    );
    await syncOffers(withinSchedule);
  } catch (err) {
    console.error('[scheduler] Offer sync failed:', err);
  } finally {
    syncInProgress = false;
  }
}

async function runHourlyNotifications(): Promise<void> {
  try {
    await cleanupOldLocks();

    const currentUtcHour = new Date().getUTCHours();
    // Match users whose local hour (UTC + utc_offset) equals send_job_applied_notifications_hour.
    // Modulo 24 handles wrap-around (e.g. UTC 23 + offset 2 = 1am local).
    const matchedRows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users
      WHERE send_job_applied_notifications_hour = (utc_offset + ${currentUtcHour}) % 24
    `;
    const usersToNotify = await prisma.user.findMany({
      where: { id: { in: matchedRows.map(r => r.id) } },
    });

    for (const user of usersToNotify) {
      const unnotified = await prisma.userOfferStatus.findMany({
        where: {
          client_notified: false,
          status: 'applied',
          user_offer: { user_id: user.id },
        },
        select: { id: true },
      });

      if (unnotified.length === 0) continue;

      const lockKey = `job_applied:${user.id}:${utcDateString()}`;
      const locked = await acquireNotificationLock(lockKey);
      if (!locked) {
        console.log(`[scheduler] Lock already held for ${lockKey} — skipping`);
        continue;
      }

      const agentClient = await prisma.agentClient.findFirst({
        where: { user_id: user.id },
        include: { agent: { select: { first_name: true } } },
      });

      const agentName = agentClient?.agent.first_name ?? 'Your agent';
      const count = unnotified.length;
      const body = `Your agent ${agentName} applied to ${count} new offer${count === 1 ? '' : 's'}.`;

      await sendPushToClient(user.id, 'Homo Digital', body);

      await prisma.userOfferStatus.updateMany({
        where: { id: { in: unnotified.map(r => r.id) } },
        data: { client_notified: true },
      });

      console.log(`[scheduler] Notified user ${user.id}: ${count} offer(s)`);
    }
  } catch (err) {
    console.error('[scheduler] Hourly notifications failed:', err);
  }
}

async function runHourlySyncReports(): Promise<void> {
  try {
    await cleanupOldLocks();

    const currentUtcHour = new Date().getUTCHours();
    const matchedRows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users
      WHERE profile IS NOT NULL
      AND send_sync_report_notifications_hour = (utc_offset + ${currentUtcHour}) % 24
    `;

    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);

    for (const row of matchedRows) {
      const lockKey = `sync_report:${row.id}:${utcDateString()}`;
      const locked = await acquireNotificationLock(lockKey);
      if (!locked) {
        console.log(`[sync-cron] Lock already held for ${lockKey} — skipping`);
        continue;
      }

      const todaySync = await prisma.userSync.findFirst({
        where: { user_id: row.id, created_at: { gte: startOfToday } },
      });
      if (todaySync) {
        console.log('[sync-cron] Already synced today for user:', row.id);
        continue;
      }
      try {
        await syncUserById(row.id);
      } catch (err) {
        console.error(`[sync-cron] Sync failed for user ${row.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[scheduler] Hourly sync reports failed:', err);
  }
}

async function runCategorizeSkills(): Promise<void> {
  if (categorizeInProgress) {
    console.log('[skill-categorizer] Previous run still in progress — skipping this tick');
    return;
  }
  categorizeInProgress = true;
  try {
    await categorizeSkills();
  } catch (err) {
    console.error('[skill-categorizer] Run failed:', err);
  } finally {
    categorizeInProgress = false;
  }
}

async function runProfileSyncQueue(): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { profile_ready: true, profile_synced_at: null },
      select: { id: true },
    });
    if (users.length === 0) return;
    console.log(`[profile-sync] ${users.length} user(s) pending sync`);
    for (const { id } of users) {
      if (syncingUserIds.has(id)) {
        console.log(`[profile-sync] User ${id} already syncing — skipping`);
        continue;
      }
      syncingUserIds.add(id);
      syncUserById(id)
        .catch(err =>
          console.error(`[profile-sync] Sync failed for user ${id}:`, err),
        )
        .finally(() => syncingUserIds.delete(id));
    }
  } catch (err) {
    console.error('[profile-sync] Queue scan failed:', err);
  }
}

// Builds two cron expressions from work_start_utc, work_end_utc, work_days settings:
//   '45 {start} * * {days}'          — full scrape 15min into the first working hour
//   '0 {start+1}-{end} * * {days}'   — incremental scrape every hour during working hours
async function buildExpressions(): Promise<string[]> {
  const [startRow, endRow, daysRow] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'work_start_utc' } }),
    prisma.settings.findUnique({ where: { key: 'work_end_utc' } }),
    prisma.settings.findUnique({ where: { key: 'work_days' } }),
  ]);
  const start = parseInt(startRow?.value ?? '6', 10);
  const end = parseInt(endRow?.value ?? '15', 10);
  const days = daysRow?.value ?? '1-5';
  return [`45 ${start} * * ${days}`, `0 ${start + 1}-${end} * * ${days}`];
}

export async function startScheduler(): Promise<void> {
  const expressions = await buildExpressions();
  console.log(
    `[scheduler] Built expressions from settings: ${expressions.join(' | ')}`,
  );

  let scheduled = 0;
  for (const expr of expressions) {
    if (!cron.validate(expr)) {
      console.error(
        `[scheduler] Invalid cron expression: "${expr}" — skipping`,
      );
      continue;
    }
    cron.schedule(expr, runSync);
    scheduled++;
  }

  if (scheduled === 0) {
    throw new Error(
      '[scheduler] No valid cron expressions — scheduler not started',
    );
  }

  console.log(`[scheduler] Scheduled ${scheduled} expression(s)`);

  cron.schedule('0 * * * *', runHourlyNotifications);
  console.log('[scheduler] Hourly notification job registered (0 * * * *)');

  cron.schedule('0 * * * *', runHourlySyncReports);
  console.log('[scheduler] Hourly sync report job registered (0 * * * *)');

  cron.schedule('*/15 * * * *', runProfileSyncQueue);
  console.log('[scheduler] Profile sync queue registered (*/15 * * * *)');

  cron.schedule('0 * * * *', runCategorizeSkills);
  console.log('[scheduler] Skill categorizer registered (0 * * * *)');

  console.log('[scheduler] Reading fetch_offers_after_build from DB...');
  const fetchRow = await prisma.settings.findUnique({
    where: { key: 'fetch_offers_after_build' },
  });
  const shouldFetch = fetchRow?.value === 'true';
  console.log(
    `[scheduler] fetch_offers_after_build=${fetchRow?.value ?? '(not set)'}`,
  );

  if (shouldFetch) {
    const offerCount = await prisma.offer.count();
    console.log(`[scheduler] Offers table count: ${offerCount}`);
    if (offerCount === 0) {
      console.log(
        '[scheduler] Offers table empty — running sync immediately (no grace period)',
      );
      syncOffers(false).catch(err =>
        console.error('[scheduler] Initial sync failed:', err),
      );
    } else {
      setTimeout(() => {
        console.log(
          '[scheduler] Grace period over — running initial sync (fetch_offers_after_build=true)',
        );
        syncOffers(false).catch(err =>
          console.error('[scheduler] Initial sync failed:', err),
        );
      }, STARTUP_GRACE_MS + 1_000);
      console.log(
        `[scheduler] setTimeout registered for ${STARTUP_GRACE_MS + 1_000}ms`,
      );
    }
  } else {
    console.log(
      '[scheduler] Startup sync skipped (fetch_offers_after_build=false)',
    );
  }
}
