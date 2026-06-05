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
})

cvGenerateRouter.post('/generate', validateAgentJwt, async (req, res) => {
  const parsed = GenerateCVSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body', issues: parsed.error.issues })
  }

  const { client_id, offer_text, cv_language } = parsed.data
  const agentId = req.agent!.id

  // Verify client belongs to this agent
  const link = await prisma.agentClient.findUnique({
    where: { agent_id_user_id: { agent_id: agentId, user_id: client_id } },
    include: { user: true },
  })

  if (!link) {
    throw new AppError(403, 'FORBIDDEN', 'Client not found or not linked to this agent')
  }

  const { user } = link

  if (!user.profile_path) {
    throw new AppError(422, 'INVALID_PROFILE', 'No profile configured for this client')
  }

  let rawProfile: unknown
  try {
    rawProfile = JSON.parse(fs.readFileSync(path.resolve(user.profile_path), 'utf-8'))
  } catch {
    throw new AppError(422, 'INVALID_PROFILE', `Profile file not found: ${user.profile_path}`)
  }

  const profileParsed = CandidateProfileSchema.safeParse(rawProfile)
  if (!profileParsed.success) {
    throw new AppError(422, 'INVALID_PROFILE', 'Profile file is invalid')
  }

  const pdfBuffer = await generateCV(profileParsed.data, offer_text, cv_language)

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', 'attachment; filename="cv.pdf"')
  res.send(pdfBuffer)
})
