import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'
import { startSyncJob, getJob } from '../services/syncService'

export const syncRouter = Router()

syncRouter.post('/start', validateAgentJwt, async (req, res) => {
  // req.agent is guaranteed by validateAgentJwt middleware
  const agent = await prisma.agent.findUnique({ where: { id: req.agent!.id } })
  if (!agent) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Agent not found' })
  }
  const agentName = [agent.first_name, agent.last_name].filter(s => s.length > 0).join(' ') || agent.email
  const jobId = startSyncJob(agent.id, agent.email, agentName)
  res.json({ job_id: jobId })
})

const StatusQuerySchema = z.object({
  job_id: z.string().min(1),
})

syncRouter.get('/status', validateAgentJwt, (req, res) => {
  const parsed = StatusQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(422).json({
      error: 'INVALID_REQUEST',
      message: 'Missing required query param: job_id',
    })
  }

  const job = getJob(parsed.data.job_id)
  if (!job) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' })
  }

  res.json(job)
})

