import cron from 'node-cron'
import { prisma } from './prisma'
import { syncOffers } from '../jobs/offerSync'

// Two expressions separated by '|' — tuned for CEST (UTC+2, summer):
//   '45 6 * * 1-5'   — 06:45 UTC = 08:45 CEST (full scrape)
//   '0 7-15 * * 1-5' — 07:00-15:00 UTC = 09:00-17:00 CEST, top of each hour
// In October (CET, UTC+1): change to '45 7 * * 1-5|0 8-16 * * 1-5'
const DEFAULT_SCHEDULE = '45 6 * * 1-5|0 7-15 * * 1-5'

let syncInProgress = false

// Mon-Fri 06:45-15:59 UTC = 08:45-17:59 CEST (UTC+2, summer)
// In October (CET, UTC+1): update to hour >= 7 && hour <= 16
function isWithinSchedule(): boolean {
  const now = new Date()
  const day = now.getUTCDay()   // 0=Sun … 6=Sat
  const hour = now.getUTCHours()
  const min = now.getUTCMinutes()
  const afterStart = hour > 6 || (hour === 6 && min >= 45)
  const beforeEnd = hour <= 15
  return day >= 1 && day <= 5 && afterStart && beforeEnd
}

function cetTimeString(): string {
  return new Date().toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw' })
}

async function runSync(): Promise<void> {
  if (!isWithinSchedule()) {
    console.log('[scheduler] Outside working hours — skipping sync')
    return
  }
  if (syncInProgress) {
    console.log('[scheduler] Previous sync still running — skipping this tick')
    return
  }
  console.log(`[scheduler] Starting scheduled sync at ${cetTimeString()}`)
  syncInProgress = true
  try {
    await syncOffers()
  } catch (err) {
    console.error('[scheduler] Offer sync failed:', err)
  } finally {
    syncInProgress = false
  }
}

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

  // Startup sync — isWithinSchedule() guard applies
  runSync().catch(err => console.error('[scheduler] Startup sync failed:', err))
}
