import cron from 'node-cron'
import { prisma } from './prisma'
import { syncOffers } from '../jobs/offerSync'

const STARTUP_GRACE_MS = 5 * 60 * 1000
const startupTime = Date.now()

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

  // Parse 'min-max' day range, e.g. '1-5' → [1, 5]; default to Mon-Fri on invalid value
  const [rawMin, rawMax] = (daysRow?.value ?? '1-5').split('-').map(Number)
  const minDay = isNaN(rawMin) ? 1 : rawMin
  const maxDay = isNaN(rawMax) ? 5 : rawMax
  if (isNaN(rawMin) || isNaN(rawMax)) {
    console.error(`[scheduler] Invalid work_days value: "${daysRow?.value}" — defaulting to Mon-Fri (1-5)`)
  }

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
  if (Date.now() - startupTime < STARTUP_GRACE_MS) {
    console.log('[scheduler] Skipping first tick — within 5min grace period after startup')
    return
  }
  if (syncInProgress) {
    console.log('[scheduler] Previous sync still running — skipping this tick')
    return
  }
  syncInProgress = true
  try {
    const withinSchedule = await isWithinSchedule()
    console.log(`[scheduler] Starting sync at ${cetTimeString()} (cleanup: ${withinSchedule})`)
    await syncOffers(withinSchedule)
  } catch (err) {
    console.error('[scheduler] Offer sync failed:', err)
  } finally {
    syncInProgress = false
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
  ])
  const start = parseInt(startRow?.value ?? '6', 10)
  const end   = parseInt(endRow?.value   ?? '15', 10)
  const days  = daysRow?.value ?? '1-5'
  return [
    `45 ${start} * * ${days}`,
    `0 ${start + 1}-${end} * * ${days}`,
  ]
}

export async function startScheduler(): Promise<void> {
  const expressions = await buildExpressions()
  console.log(`[scheduler] Built expressions from settings: ${expressions.join(' | ')}`)

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
    throw new Error('[scheduler] No valid cron expressions — scheduler not started')
  }

  console.log(`[scheduler] Scheduled ${scheduled} expression(s)`)

  console.log('[scheduler] Reading fetch_offers_after_build from DB...')
  const fetchRow = await prisma.settings.findUnique({ where: { key: 'fetch_offers_after_build' } })
  const shouldFetch = fetchRow?.value === 'true'
  console.log(`[scheduler] fetch_offers_after_build=${fetchRow?.value ?? '(not set)'}`)

  if (shouldFetch) {
    const offerCount = await prisma.offer.count()
    console.log(`[scheduler] Offers table count: ${offerCount}`)
    if (offerCount === 0) {
      console.log('[scheduler] Offers table empty — running sync immediately (no grace period)')
      syncOffers(false).catch(err => console.error('[scheduler] Initial sync failed:', err))
    } else {
      setTimeout(
        () => {
          console.log('[scheduler] Grace period over — running initial sync (fetch_offers_after_build=true)')
          syncOffers(false).catch(err => console.error('[scheduler] Initial sync failed:', err))
        },
        STARTUP_GRACE_MS + 1_000
      )
      console.log(`[scheduler] setTimeout registered for ${STARTUP_GRACE_MS + 1_000}ms`)
    }
  } else {
    console.log('[scheduler] Startup sync skipped (fetch_offers_after_build=false)')
  }
}
