import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { prisma } from '../lib/prisma'
import { env } from '../lib/env'
import { validateSupabaseJwt } from '../middleware/validateSupabaseJwt'
import { getSupabase } from '../lib/supabase'

export const authRouter = Router()

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

authRouter.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body' })
  }
  const { email, password } = parsed.data

  // 1. Agent lookup — uses password_hash column
  const agent = await prisma.agent.findUnique({ where: { email } })
  if (agent) {
    const valid = await bcrypt.compare(password, agent.password_hash)
    if (!valid) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials' })
    }
    const token = jwt.sign(
      { role: 'agent', agent_id: agent.id, email: agent.email },
      env.JWT_SECRET,
      { expiresIn: '30d' },
    )
    return res.json({ token, role: 'agent', agent_id: agent.id })
  }

  // 2. Client/user lookup — uses password column
  const user = await prisma.user.findUnique({ where: { email } })
  if (user?.password) {
    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials' })
    }
    const token = jwt.sign(
      { role: 'client', user_id: user.id, email: user.email },
      env.JWT_SECRET,
      { expiresIn: '30d' },
    )
    return res.json({ token, role: 'client', user_id: user.id })
  }

  // 3. Not found or no password set
  return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials' })
})

authRouter.post('/social-login', validateSupabaseJwt, async (req, res) => {
  const { email } = req.supabase_user!

  const token = req.headers.authorization!.slice(7)
  const { data: { user: supabaseUser } } = await getSupabase().auth.getUser(token)
  const photoUrl = (supabaseUser?.user_metadata?.['avatar_url'] as string | undefined) ?? null

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      jobmatcher_api_key: `jm_live_${crypto.randomBytes(16).toString('hex')}`,
      photo_url: photoUrl,
    },
    update: {
      email,
      ...(photoUrl ? { photo_url: photoUrl } : {}),
    },
    select: { id: true },
  })

  const jmToken = jwt.sign(
    { role: 'client', user_id: user.id, email },
    env.JWT_SECRET,
    { expiresIn: '30d' },
  )

  res.json({ token: jmToken, role: 'client', user_id: user.id })
})
