import cron from 'node-cron'
import { prisma } from './prisma'
import { syncOffers } from '../jobs/offerSync'

let syncInProgress = false

async function runSync(): Promise<void> {
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
    where: { key: 'cronjob_interval_minutes' },
  })

  const raw = setting ? parseInt(setting.value, 10) : 10
  const intervalMinutes = !isNaN(raw) && raw >= 1 && raw <= 59 ? raw : 10

  const expression = `*/${intervalMinutes} * * * *`
  cron.schedule(expression, runSync)

  console.log(`[scheduler] Offer sync scheduled every ${intervalMinutes} minutes`)

  // Run once on startup so the DB has fresh data immediately after deploy
  runSync().catch(err => console.error('[scheduler] Startup sync failed:', err))
}
