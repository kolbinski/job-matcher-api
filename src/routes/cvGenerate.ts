import fs from 'fs'
import path from 'path'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateAgentJwt } from '../middleware/validateAgentJwt'
import { generateCV } from '../services/cvGenerator'
import { CandidateProfileSchema } from '../types/profile'
import { AppError } from '../lib/errors'

export const cvGenerateRouter = Router()

const GenerateCVSchema = z.object({
  client_id: z.string().uuid(),
  offer_text: z.string().min(1),
  cv_language: z.string().min(2),
  company_name: z.string().optional(),
  job_title: z.string().optional(),
})

cvGenerateRouter.post('/generate', validateAgentJwt, async (req, res) => {
  console.log('[cvGenerate] body:', JSON.stringify(req.body))

  const parsed = GenerateCVSchema.safeParse(req.body)
  if (!parsed.success) {
    console.log('[cvGenerate] schema validation failed:', JSON.stringify(parsed.error.issues))
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body', issues: parsed.error.issues })
  }

  const { client_id, offer_text, cv_language, company_name, job_title } = parsed.data
  const agentId = req.agent!.id

  // Verify client belongs to this agent
  const link = await prisma.agentClient.findUnique({
    where: { agent_id_user_id: { agent_id: agentId, user_id: client_id } },
    include: { user: true },
  })

  if (!link) {
    console.log('[cvGenerate] agent-client link not found: agentId=%s clientId=%s', agentId, client_id)
    throw new AppError(403, 'FORBIDDEN', 'Client not found or not linked to this agent')
  }

  const { user } = link
  console.log('[cvGenerate] user found: id=%s profile_path=%s', user.id, user.profile_path)

  if (!user.profile_path) {
    console.log('[cvGenerate] no profile_path on user')
    throw new AppError(422, 'INVALID_PROFILE', 'No profile configured for this client')
  }

  let rawProfile: unknown
  try {
    rawProfile = JSON.parse(fs.readFileSync(path.resolve(user.profile_path), 'utf-8'))
  } catch (err) {
    console.log('[cvGenerate] profile file read failed: path=%s error=%s', user.profile_path, String(err))
    throw new AppError(422, 'INVALID_PROFILE', `Profile file not found: ${user.profile_path}`)
  }

  const profileParsed = CandidateProfileSchema.safeParse(rawProfile)
  if (!profileParsed.success) {
    console.log('[cvGenerate] profile schema invalid:', JSON.stringify(profileParsed.error.issues))
    throw new AppError(422, 'INVALID_PROFILE', 'Profile file is invalid')
  }

  const { html, filename } = await generateCV(profileParsed.data, offer_text, cv_language, job_title, company_name)

  res.json({ html, filename })
})
