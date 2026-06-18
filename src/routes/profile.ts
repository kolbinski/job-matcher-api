import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { syncUserById } from '../services/syncService'
import { AppError } from '../lib/errors'
import { compareMatchingFields } from '../lib/profileComparison'

export const profileRouter = Router()

const BodySchema = z.object({
  profile: z.record(z.string(), z.unknown()).optional(),
  profile_ready: z.boolean().optional(),
  client_id: z.string().uuid().optional(),
}).refine(data => data.profile !== undefined || data.profile_ready !== undefined, {
  message: 'At least one of profile or profile_ready must be provided',
})

profileRouter.get('/', validateJwt, async (req, res) => {
  if (req.jwt!.role === 'agent') {
    const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : undefined
    if (!clientId) {
      throw new AppError(422, 'INVALID_REQUEST', 'client_id query param is required when using agent JWT')
    }

    const link = await prisma.agentClient.findUnique({
      where: { agent_id_user_id: { agent_id: req.jwt!.agent_id!, user_id: clientId } },
    })

    if (!link) {
      throw new AppError(403, 'FORBIDDEN', 'Agent does not have access to this client')
    }

    const user = await prisma.user.findUnique({
      where: { id: clientId },
      select: { profile: true, profile_ready: true, offer_skills: true },
    })

    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'Client not found')
    }

    return res.json({ ...user, offer_skills: ((user.offer_skills ?? []) as unknown as Array<{ dismissed: boolean }>).filter(s => !s.dismissed) })
  }

  const user = await prisma.user.findUnique({
    where: { id: req.jwt!.user_id! },
    select: { profile: true, profile_ready: true, offer_skills: true },
  })

  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'User not found')
  }

  res.json({ ...user, offer_skills: ((user.offer_skills ?? []) as unknown as Array<{ dismissed: boolean }>).filter(s => !s.dismissed) })
})

profileRouter.patch('/', validateJwt, async (req, res) => {
  const parsed = BodySchema.safeParse(req.body)
  if (!parsed.success) {
    throw new AppError(422, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request body')
  }

  const { profile, profile_ready, client_id } = parsed.data

  // Resolve userId from agent or client JWT
  let userId: string
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
    userId = client_id
  } else {
    userId = req.jwt!.user_id!
  }

  // Snapshot logic: fetch current state before updating
  let snapshotForComparison: unknown = null
  let snapshotUpdate: { profile_editing_snapshot?: Prisma.InputJsonValue | Prisma.NullTypes.JsonNull } = {}

  if (profile_ready === false) {
    // Entering edit mode: capture current DB profile as snapshot
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { profile: true },
    })
    snapshotUpdate = {
      profile_editing_snapshot: current?.profile != null
        ? (current.profile as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    }
  } else if (profile_ready === true) {
    // Leaving edit mode: fetch snapshot for comparison but do NOT clear it here —
    // trigger-sync reads it to decide whether to increment the rematch counter.
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { profile_editing_snapshot: true },
    })
    snapshotForComparison = current?.profile_editing_snapshot ?? null
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(profile !== undefined ? { profile: profile as Prisma.InputJsonValue } : {}),
      ...(profile_ready !== undefined ? { profile_ready } : {}),
      ...snapshotUpdate,
    },
    select: { profile: true, profile_ready: true },
  })

  // Compare snapshot against the full merged profile from DB (not partial incoming body)
  const matching_relevant_change = profile_ready === true
    ? compareMatchingFields(snapshotForComparison, updated.profile)
    : undefined

  res.json(matching_relevant_change !== undefined
    ? { ...updated, matching_relevant_change }
    : updated,
  )
})

const TriggerSyncBodySchema = z.object({
  force_relevant_change: z.boolean().optional(),
})

profileRouter.post('/trigger-sync', validateJwt, async (req, res) => {
  if (req.jwt!.role !== 'client') {
    throw new AppError(403, 'FORBIDDEN', 'Only client JWT is allowed')
  }

  const userId = req.jwt!.user_id!

  const bodyParsed = TriggerSyncBodySchema.safeParse(req.body)
  const forceRelevantChange = bodyParsed.success ? (bodyParsed.data.force_relevant_change ?? false) : false

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      profile: true,
      profile_editing_snapshot: true,
      profile_relevant_change_counter: true,
      profile_relevant_change_counter_max: true,
    },
  })
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found')

  const matchingRelevantChange = forceRelevantChange || compareMatchingFields(user.profile_editing_snapshot, user.profile)
  console.log(`[trigger-sync] userId=${userId} matchingRelevantChange=${matchingRelevantChange} forceRelevantChange=${forceRelevantChange} counter=${user.profile_relevant_change_counter} counter_max=${user.profile_relevant_change_counter_max} snapshotNull=${user.profile_editing_snapshot == null}`)

  if (matchingRelevantChange) {
    if (user.profile_relevant_change_counter >= user.profile_relevant_change_counter_max) {
      await prisma.user.update({
        where: { id: userId },
        data: { profile_relevant_change_pending: true },
      })
      return res.status(402).json({ error: 'PROFILE_REMATCH_LIMIT_REACHED' })
    }
    await prisma.user.update({
      where: { id: userId },
      data: {
        profile_relevant_change_counter: { increment: 1 },
        profile_relevant_change_pending: false,
        profile_synced_at: new Date(),
        profile_editing_snapshot: Prisma.JsonNull,
      },
    })
  } else {
    await prisma.user.update({
      where: { id: userId },
      data: { profile_synced_at: new Date(), profile_editing_snapshot: Prisma.JsonNull },
    })
  }

  console.log(`[trigger-sync] Deleting stale offers for user ${userId}`)

  let deleted = 1
  while (deleted > 0) {
    const result = await prisma.$executeRaw`
      DELETE FROM user_offer_statuses
      WHERE id IN (
        SELECT uos.id FROM user_offer_statuses uos
        JOIN user_offers uo ON uos.user_offer_id = uo.id
        WHERE uo.user_id = ${userId}
        AND uo.status IN ('pending_apply', 'ai_rejected', 'pre_filter_rejected')
        LIMIT 1000
      )`
    deleted = result
    if (deleted > 0) console.log(`[trigger-sync] Deleted ${deleted} user_offer_statuses rows`)
  }
  console.log(`[trigger-sync] user_offer_statuses cleanup done`)

  deleted = 1
  while (deleted > 0) {
    const result = await prisma.$executeRaw`
      DELETE FROM user_offers
      WHERE id IN (
        SELECT id FROM user_offers
        WHERE user_id = ${userId}
        AND status IN ('pending_apply', 'ai_rejected', 'pre_filter_rejected')
        LIMIT 1000
      )`
    deleted = result
    if (deleted > 0) console.log(`[trigger-sync] Deleted ${deleted} user_offers rows`)
  }
  console.log(`[trigger-sync] user_offers cleanup done`)

  await prisma.notificationLock.deleteMany({
    where: { lock_key: { startsWith: `sync:${userId}` } },
  })
  console.log('[trigger-sync] cleared sync lock for userId:', userId)

  res.status(202).json({ message: 'Sync queued' })

  syncUserById(userId).catch(err =>
    console.error(`[trigger-sync] Sync failed for user ${userId}:`, err),
  )
})

const DismissSkillBodySchema = z.object({ name: z.string().min(1) })

profileRouter.post('/dismiss-skill', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const parsed = DismissSkillBodySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'name must be a non-empty string' })
  }

  const { name } = parsed.data
  const user = await prisma.user.findUnique({
    where: { id: user_id! },
    select: { offer_skills: true },
  })

  interface OfferSkillEntry { name: string; count: number; category_name: string; dismissed: boolean; }
  const skills = (user?.offer_skills ?? []) as unknown as OfferSkillEntry[]
  const updated = skills.map(s =>
    s.name.toLowerCase() === name.toLowerCase() ? { ...s, dismissed: true } : s,
  )

  await prisma.user.update({
    where: { id: user_id! },
    data: { offer_skills: updated as unknown as Prisma.InputJsonValue },
  })

  return res.json({ success: true })
})

profileRouter.post('/cancel-edit', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const user = await prisma.user.findUnique({
    where: { id: user_id! },
    select: { profile_editing_snapshot: true },
  })

  if (!user || user.profile_editing_snapshot === null) {
    return res.status(400).json({ error: 'NO_SNAPSHOT' })
  }

  await prisma.user.update({
    where: { id: user_id! },
    data: {
      profile: user.profile_editing_snapshot as Prisma.InputJsonValue,
      profile_editing_snapshot: Prisma.JsonNull,
      profile_ready: true,
    },
  })

  return res.json({ success: true })
})
