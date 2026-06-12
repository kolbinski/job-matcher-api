import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { AppError } from '../lib/errors'

export const profileRouter = Router()

const BodySchema = z.object({
  profile: z.record(z.string(), z.unknown()).optional(),
  profile_ready: z.boolean().optional(),
  client_id: z.string().uuid().optional(),
}).refine(data => data.profile !== undefined || data.profile_ready !== undefined, {
  message: 'At least one of profile or profile_ready must be provided',
})

profileRouter.get('/', validateJwt, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.jwt!.user_id! },
    select: { profile: true, profile_ready: true },
  })

  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'User not found')
  }

  res.json(user)
})

profileRouter.patch('/', validateJwt, async (req, res) => {
  const parsed = BodySchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(422, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request body')
  }

  const { profile, profile_ready, client_id } = parsed.data

  if (req.jwt!.role === 'agent') {
    if (!client_id) {
      throw new AppError(422, 'INVALID_REQUEST', 'client_id is required when using agent JWT')
    }

    const link = await prisma.agentClient.findUnique({
      where: { agent_id_user_id: { agent_id: req.jwt!.agent_id!, user_id: client_id } },
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

  // Client path — internal JWT (role === 'client')
  const updated = await prisma.user.update({
    where: { id: req.jwt!.user_id! },
    data: {
      ...(profile !== undefined ? { profile: profile as Prisma.InputJsonValue } : {}),
      ...(profile_ready !== undefined ? { profile_ready } : {}),
    },
    select: { profile: true, profile_ready: true },
  })

  res.json(updated)
})
