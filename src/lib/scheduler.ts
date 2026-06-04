import cron from 'node-cron'
import { prisma } from './prisma'
import { syncOffers } from '../jobs/offerSync'

// Two expressions separated by '|' — tuned for CEST (UTC+2, summer):
//   '45 6 * * 1-5'   — 06:45 UTC = 08:45 CEST (full scrape)
//   '0 7-15 * * 1-5' — 07:00-15:00 UTC = 09:00-17:00 CEST, top of each hour
// In October (CET, UTC+1): change to '45 7 * * 1-5|0 8-16 * * 1-5'
const DEFAULT_SCHEDULE = '45 6 * * 1-5|0 7-15 * * 1-5'

let syncInProgress = false

// Reads work_start_utc, work_end_utc, work_days from settings on every call
// so DB changes take effect immediately without redeploy.
async function isWithinSchedule(): Promise<boolean> {
  const [startRow, endRow, daysRow] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'work_start_utc' } }),
    prisma.settings.findUnique({ where: { key: 'work_end_utc' } }),
    prisma.settings.findUnique({ where: { key: 'work_days' } }),
  ])

  const startHour = parseInt(startRow?.value ?? '6', 10)
  const endHour   = parseInt(endRow?.value   ?? '15', 10)

  // Parse 'min-max' day range, e.g. '1-5' → [1, 5]
  const [minDay, maxDay] = (daysRow?.value ?? '1-5').split('-').map(Number)

  const now  = new Date()
  const day  = now.getUTCDay()
  const hour = now.getUTCHours()

  const afterStart = hour >= startHour
  const beforeEnd  = hour <= endHour
  return day >= minDay && day <= maxDay && afterStart && beforeEnd
}

function cetTimeString(): string {
  return new Date().toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw' })
}

async function runSync(): Promise<void> {
  const withinSchedule = await isWithinSchedule()
  if (syncInProgress) {
    console.log('[scheduler] Previous sync still running — skipping this tick')
    return
  }
  console.log(`[scheduler] Starting sync at ${cetTimeString()} (cleanup: ${withinSchedule})`)
  syncInProgress = true
  try {
    await syncOffers(withinSchedule)
  } catch (err) {
    console.error('[scheduler] Offer sync failed:', err)
  } finally {
    syncInProgress = false
  }
}

// cronjob_schedule controls WHEN the cron fires — read once at startup, requires redeploy to change.
// work_start_utc / work_end_utc / work_days control WHETHER the sync runs — read on every tick,
// so DB changes take effect immediately without redeploying.
export async function startScheduler(): Promise<void> {
  const setting = await prisma.settings.findUnique({
    where: { key: 'cronjob_schedule' },
  })

  const raw = setting?.value ?? DEFAULT_SCHEDULE
  const expressions = raw.split('|').map(e => e.trim()).filter(Boolean)

  let scheduled = 0
  for (const expr of expressions) {
    if (!cron.validate(expr)) {
      console.error(`[scheduler] Invalid cron expression: "${expr}" — skipping`)
      continue
    }
    cron.schedule(expr, runSync)
    scheduled++
  }

  if (scheduled === 0) {
    console.error('[scheduler] No valid cron expressions found — scheduler not started')
    return
  }

  console.log(`[scheduler] Scheduled ${scheduled} expression(s): ${expressions.join(' | ')}`)

  // Startup sync always runs; cleanup is skipped if outside working hours.
  runSync().catch(err => console.error('[scheduler] Startup sync failed:', err))
}
