import cron from 'node-cron'
import { prisma } from './prisma'
import { syncOffers } from '../jobs/offerSync'

// Two expressions separated by '|':
//   '45 7 * * 1-5'   — 08:45 CET (full scrape)
//   '0 8-16 * * 1-5' — 09:00-17:00 CET, top of each hour
const DEFAULT_SCHEDULE = '45 7 * * 1-5|0 8-16 * * 1-5'

let syncInProgress = false

// Mon-Fri 07:45-16:59 UTC = 08:45-17:59 CET
function isWithinSchedule(): boolean {
  const now = new Date()
  const day = now.getUTCDay()   // 0=Sun … 6=Sat
  const hour = now.getUTCHours()
  const min = now.getUTCMinutes()
  const afterStart = hour > 7 || (hour === 7 && min >= 45)
  const beforeEnd = hour <= 16
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
