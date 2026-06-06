import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma'
import { runMatchForUser } from './matchService'
import { buildEmailReport } from './emailReport'

interface SyncClientResult {
  client_id: string
  first_name: string | null
  last_name: string | null
  new_offers_count: number
  stretch_offers_count: number
  email_report: string
  error?: string
}

export interface SyncJob {
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at?: string
  progress: number
  total_clients: number
  processed_clients: number
  total_new_offers: number
  clients: SyncClientResult[]
}

const jobs = new Map<string, SyncJob>()

export function getJob(jobId: string): SyncJob | undefined {
  return jobs.get(jobId)
}

export function startSyncJob(): string {
  const jobId = randomUUID()
  const job: SyncJob = {
    status: 'running',
    started_at: new Date().toISOString(),
    progress: 0,
    total_clients: 0,
    processed_clients: 0,
    total_new_offers: 0,
    clients: [],
  }
  jobs.set(jobId, job)

  runJob(job).catch(err => {
    job.status = 'error'
    job.finished_at = new Date().toISOString()
    console.error('[syncService] runJob failed:', err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : '')
  })

  return jobId
}

async function runJob(job: SyncJob): Promise<void> {
  const users = await prisma.user.findMany({
    where: { profile_path: { not: null } },
    select: { id: true, email: true, first_name: true, last_name: true, profile_path: true },
  })

  job.total_clients = users.length
  console.log(`[sync] Starting job for ${users.length} users`)

  for (const user of users) {
    try {
      const result = await runMatchForUser(user.id, { ai_scoring: true })

      const newOffersCount = result.matched.filter(o => o.recommended === true).length
      const stretchCount = result.stretch_offers.length

      job.clients.push({
        client_id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        new_offers_count: newOffersCount,
        stretch_offers_count: stretchCount,
        email_report: buildEmailReport(result, user),
      })
      job.total_new_offers += newOffersCount + stretchCount

      console.log(`[sync] ${user.email}: ${newOffersCount} new offers, ${stretchCount} stretch`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[syncService] client failed:', user.id, message)
      job.clients.push({
        client_id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        new_offers_count: 0,
        stretch_offers_count: 0,
        email_report: '',
        error: message,
      })
    }

    job.processed_clients++
    job.progress = Math.round((job.processed_clients / job.total_clients) * 100)
  }

  job.status = 'done'
  job.finished_at = new Date().toISOString()
  console.log(`[sync] Job done. total_new_offers=${job.total_new_offers}`)
}
