import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma'

interface SyncClientResult {
  client_id: string
  client_email: string
  first_name: string | null
  new_offers: number
  stretch_offers: number
  error?: string
}

export interface SyncJob {
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at?: string
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
    total_new_offers: 0,
    clients: [],
  }
  jobs.set(jobId, job)

  runJob(job).catch(err => {
    job.status = 'error'
    job.finished_at = new Date().toISOString()
    console.error('[sync] Job failed:', err)
  })

  return jobId
}

async function runJob(job: SyncJob): Promise<void> {
  const port = process.env.PORT ?? '3000'
  const baseUrl = `http://localhost:${port}`

  const users = await prisma.user.findMany({
    where: { profile_path: { not: null } },
    select: { id: true, email: true, first_name: true, jobmatcher_api_key: true },
  })

  console.log(`[sync] Starting job for ${users.length} users`)

  for (const user of users) {
    try {
      const res = await fetch(`${baseUrl}/v1/match`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': user.jobmatcher_api_key,
        },
        body: JSON.stringify({ options: { ai_scoring: true } }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`HTTP ${res.status}: ${body}`)
      }

      const data = await res.json() as {
        matched: Array<{ recommended: boolean | null }>
        stretch_offers: unknown[]
      }

      const newOffers = data.matched.filter(o => o.recommended === true).length
      const stretchCount = data.stretch_offers.length

      job.clients.push({
        client_id: user.id,
        client_email: user.email,
        first_name: user.first_name,
        new_offers: newOffers,
        stretch_offers: stretchCount,
      })
      job.total_new_offers += newOffers + stretchCount

      console.log(`[sync] ${user.email}: ${newOffers} new offers, ${stretchCount} stretch`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[sync] ${user.email} failed:`, message)
      job.clients.push({
        client_id: user.id,
        client_email: user.email,
        first_name: user.first_name,
        new_offers: 0,
        stretch_offers: 0,
        error: message,
      })
    }
  }

  job.status = 'done'
  job.finished_at = new Date().toISOString()
  console.log(`[sync] Job done. total_new_offers=${job.total_new_offers}`)
}
