import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { sendFeedbackNotification } from '../services/emailService'

export const feedbackRouter = Router()

const BodySchema = z.object({
  message: z.string().min(1),
  source: z.string().min(1),
})

feedbackRouter.post('/', validateJwt, async (req, res) => {
  const parsed = BodySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body', issues: parsed.error.issues })
  }

  const { role, user_id, agent_id, email } = req.jwt!
  const { message, source } = parsed.data

  const feedback = await prisma.feedback.create({
    data: {
      message,
      source,
      user_id: role === 'client' ? user_id : null,
      agent_id: role === 'agent' ? agent_id : null,
    },
  })

  await sendFeedbackNotification(email ?? 'unknown', source, message, feedback.created_at)

  return res.status(201).json({ ok: true, id: feedback.id })
})
