import { Router } from 'express'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import { env } from '../lib/env'
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

const ProgressQuerySchema = z.object({
  job_id: z.string().min(1),
  token: z.string().min(1),
})

// SSE endpoint — EventSource can't send Authorization header, so token comes via query param.
syncRouter.get('/progress', (req, res) => {
  const parsed = ProgressQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(422).json({
      error: 'INVALID_REQUEST',
      message: 'Missing required query params: job_id, token',
    })
  }

  const { job_id, token } = parsed.data

  try {
    jwt.verify(token, env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or expired token' })
  }

  const initialJob = getJob(job_id)
  if (!initialJob) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Send current state immediately
  res.write(`data: ${JSON.stringify(initialJob)}\n\n`)

  if (initialJob.status === 'done' || initialJob.status === 'error') {
    res.end()
    return
  }

  const keepalive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n')
    }
  }, 15000)

  const pollInterval = setInterval(() => {
    try {
      const current = getJob(job_id)
      if (!current) {
        clearInterval(pollInterval)
        clearInterval(keepalive)
        res.end()
        return
      }
      res.write(`data: ${JSON.stringify(current)}\n\n`)
      if (current.status === 'done' || current.status === 'error') {
        clearInterval(pollInterval)
        clearInterval(keepalive)
        res.end()
      }
    } catch {
      clearInterval(pollInterval)
      clearInterval(keepalive)
    }
  }, 500)

  req.on('close', () => {
    clearInterval(keepalive)
    clearInterval(pollInterval)
  })
})
