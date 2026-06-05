import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { prisma } from '../lib/prisma'
import { env } from '../lib/env'
import { AppError } from '../lib/errors'

export const agentAuthRouter = Router()

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

agentAuthRouter.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body' })
  }

  const { email, password } = parsed.data

  const agent = await prisma.agent.findUnique({ where: { email } })
  if (!agent) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')
  }

  const valid = await bcrypt.compare(password, agent.password_hash)
  if (!valid) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')
  }

  const token = jwt.sign({ agentId: agent.id, email: agent.email }, env.JWT_SECRET, { expiresIn: '30d' })
  res.json({ token })
})
