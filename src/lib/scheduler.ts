import cron from 'node-cron'
import { prisma } from './prisma'
import { syncOffers } from '../jobs/offerSync'

const DEFAULT_SCHEDULE = '45,0,15,30 7-15 * * 1-5'

let syncInProgress = false

// Mon-Fri 07:00-15:59 UTC = 08:00-16:59 CET, covering the 08:45-17:00 CET window
function isWithinSchedule(): boolean {
  const now = new Date()
  const day = now.getUTCDay()  // 0=Sun … 6=Sat
  const hour = now.getUTCHours()
  return day >= 1 && day <= 5 && hour >= 7 && hour <= 15
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

  const schedule = setting?.value ?? DEFAULT_SCHEDULE

  if (!cron.validate(schedule)) {
    console.error(`[scheduler] Invalid cron expression in settings: "${schedule}" — scheduler not started`)
    return
  }

  cron.schedule(schedule, runSync)
  console.log(`[scheduler] Offer sync scheduled: ${schedule}`)

  // Startup sync — isWithinSchedule() guard applies here too
  runSync().catch(err => console.error('[scheduler] Startup sync failed:', err))
}
