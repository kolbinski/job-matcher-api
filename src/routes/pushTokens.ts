import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'

export const pushTokensRouter = Router()

const BodySchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['android', 'ios']),
})

pushTokensRouter.post('/', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can register push tokens' })
  }

  const parsed = BodySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body', issues: parsed.error.issues })
  }

  const { token, platform } = parsed.data

  await prisma.pushToken.upsert({
    where: { token },
    update: { user_id: user_id!, updated_at: new Date() },
    create: { user_id: user_id!, token, platform },
  })

  return res.status(200).json({ ok: true })
})
