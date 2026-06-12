import { Router } from 'express'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import type { Prisma } from '@prisma/client'
import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../lib/prisma'
import { validateSupabaseJwt } from '../middleware/validateSupabaseJwt'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'

export const profileRouter = Router()

// Accepts agent internal JWT (role==='agent') or Supabase client JWT.
// Agent tokens set req.jwt; Supabase tokens set req.supabase_user.
async function validateProfileAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header')
  }
  const token = auth.slice(7)
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { role?: string; agent_id?: string; email: string }
    if (payload.role === 'agent') {
      req.jwt = { role: 'agent', agent_id: payload.agent_id, email: payload.email }
      return next()
    }
  } catch {
    // not an internal JWT — fall through to Supabase
  }
  return validateSupabaseJwt(req, res, next)
}

const BodySchema = z.object({
  profile: z.record(z.string(), z.unknown()).optional(),
  profile_ready: z.boolean().optional(),
  client_id: z.string().uuid().optional(),
}).refine(data => data.profile !== undefined || data.profile_ready !== undefined, {
  message: 'At least one of profile or profile_ready must be provided',
})

profileRouter.get('/', validateSupabaseJwt, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { email: req.supabase_user!.email },
    select: { profile: true, profile_ready: true },
  })

  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'User not found')
  }

  res.json(user)
})

profileRouter.patch('/', validateProfileAuth, async (req, res) => {
  const parsed = BodySchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(422, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request body')
  }

  const { profile, profile_ready, client_id } = parsed.data

  if (req.jwt?.role === 'agent') {
    if (!client_id) {
      throw new AppError(422, 'INVALID_REQUEST', 'client_id is required when using agent JWT')
    }

    const link = await prisma.agentClient.findUnique({
      where: { agent_id_user_id: { agent_id: req.jwt.agent_id!, user_id: client_id } },
    })

    if (!link) {
      throw new AppError(403, 'FORBIDDEN', 'Agent does not have access to this client')
    }

    const updated = await prisma.user.update({
      where: { id: client_id },
      data: {
        ...(profile !== undefined ? { profile: profile as Prisma.InputJsonValue } : {}),
        ...(profile_ready !== undefined ? { profile_ready } : {}),
      },
      select: { profile: true, profile_ready: true },
    })

    return res.json(updated)
  }

  // Client path — Supabase JWT
  const user = await prisma.user.findUnique({
    where: { email: req.supabase_user!.email },
    select: { id: true },
  })

  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'User not found')
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(profile !== undefined ? { profile: profile as Prisma.InputJsonValue } : {}),
      ...(profile_ready !== undefined ? { profile_ready } : {}),
    },
    select: { profile: true, profile_ready: true },
  })

  res.json(updated)
})
