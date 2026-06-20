import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { syncUserById, buildAndSaveFreePlanSnapshot } from '../services/syncService'
import { AppError } from '../lib/errors'
import { compareMatchingFields, compareMatchingFieldsExcludingSalary, stableStringify, getField } from '../lib/profileComparison'
import { calculateUserOfferSalary } from '../lib/salaryCalculator'
import { applyPreFilters } from '../services/redFlagFilter'
import { CandidateProfileSchema } from '../types/profile'

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
      select: { profile: true, profile_ready: true, profile_editing_snapshot: true, offer_skills: true },
    })

    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'Client not found')
    }

    return res.json({
      ...user,
      profile_editing_snapshot: user.profile_editing_snapshot ?? null,
      offer_skills: ((user.offer_skills ?? []) as unknown as Array<{ dismissed: boolean }>).filter(s => !s.dismissed),
    })
  }

  const user = await prisma.user.findUnique({
    where: { id: req.jwt!.user_id! },
    select: { profile: true, profile_ready: true, profile_editing_snapshot: true, offer_skills: true },
  })

  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'User not found')
  }

  res.json({
    ...user,
    profile_editing_snapshot: user.profile_editing_snapshot ?? null,
    offer_skills: ((user.offer_skills ?? []) as unknown as Array<{ dismissed: boolean }>).filter(s => !s.dismissed),
  })
})

// Lightweight check: does the current profile differ from the editing snapshot
// in any matching-relevant field? Same comparison as trigger-sync, but read-only
// (no DB writes, no matching).
profileRouter.get('/has-relevant-changes', validateJwt, async (req, res) => {
  if (req.jwt!.role !== 'client') {
    throw new AppError(403, 'FORBIDDEN', 'Only client JWT is allowed')
  }

  const user = await prisma.user.findUnique({
    where: { id: req.jwt!.user_id! },
    select: { profile: true, profile_editing_snapshot: true },
  })
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found')

  const has_relevant_changes = compareMatchingFields(user.profile_editing_snapshot, user.profile)
  return res.json({ has_relevant_changes })
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
      sync_started_at: true,
      preferred_currency: true,
    },
  })
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found')

  const syncInProgress = user.sync_started_at &&
    (new Date().getTime() - new Date(user.sync_started_at).getTime()) < 30 * 60 * 1000

  if (syncInProgress) {
    console.log(`[trigger-sync] userId=${userId} sync in progress — cancelling and restarting with latest profile`)
    await prisma.user.update({
      where: { id: userId },
      data: { sync_started_at: null },
    })
  }

  const matchingRelevantChange = forceRelevantChange || compareMatchingFields(user.profile_editing_snapshot, user.profile)
  console.log(`[trigger-sync] userId=${userId} matchingRelevantChange=${matchingRelevantChange} forceRelevantChange=${forceRelevantChange} counter=${user.profile_relevant_change_counter} counter_max=${user.profile_relevant_change_counter_max} snapshotNull=${user.profile_editing_snapshot == null}`)

  // ── Salary-only detection ────────────────────────────────────────────────────
  type SalaryPref = { type: string; currency: string; min: number; unit?: string }
  let isSalaryOnlyChange = false
  let salaryOnlyIncreased = false
  let oldPrefs: SalaryPref[] = []
  let newPrefs: SalaryPref[] = []

  if (matchingRelevantChange && !forceRelevantChange && user.profile_editing_snapshot != null) {
    const nonSalaryChange = compareMatchingFieldsExcludingSalary(user.profile_editing_snapshot, user.profile)
    const salaryChanged =
      stableStringify(getField(user.profile_editing_snapshot, ['preferences', 'salary'])) !==
      stableStringify(getField(user.profile, ['preferences', 'salary']))
    isSalaryOnlyChange = !nonSalaryChange && salaryChanged

    console.log('[trigger-sync] nonSalaryChange:', nonSalaryChange)
    console.log('[trigger-sync] salaryChanged:', salaryChanged)
    console.log('[trigger-sync] isSalaryOnlyChange:', isSalaryOnlyChange)
    console.log('[trigger-sync] old salary prefs:', JSON.stringify(getField(user.profile_editing_snapshot, ['preferences', 'salary'])))
    console.log('[trigger-sync] new salary prefs:', JSON.stringify(getField(user.profile, ['preferences', 'salary'])))

    if (isSalaryOnlyChange) {
      oldPrefs = ((getField(user.profile_editing_snapshot, ['preferences', 'salary']) ?? []) as SalaryPref[])
      newPrefs = ((getField(user.profile, ['preferences', 'salary']) ?? []) as SalaryPref[])
      console.log('[trigger-sync] salary-only change detected:')
      for (const newPref of newPrefs) {
        const oldPref = oldPrefs.find(p => p.type === newPref.type && p.currency === newPref.currency)
        const oldMin = oldPref?.min ?? 'none'
        console.log(`[trigger-sync]   ${newPref.type} ${newPref.currency}: ${oldMin} → ${newPref.min}`)
      }
      salaryOnlyIncreased = newPrefs.every(newPref => {
        const oldPref = oldPrefs.find(p => p.type === newPref.type && p.currency === newPref.currency)
        return !oldPref || newPref.min >= oldPref.min
      })
    }
  }

  // ── Helper: recalculate salary deltas for pending_apply/ai_rejected rows ─────
  // Returns [keptCount, rejectedCount]. Used by both partial-sync branches.
  async function recalculateSalaryDeltas(
    salaryPrefs: SalaryPref[],
    exchangeRates: Record<string, number>,
    preferredCurrency: string,
  ): Promise<[number, number]> {
    const existingOffers = await prisma.userOffer.findMany({
      where: { user_id: userId, status: { in: ['pending_apply', 'ai_rejected'] } },
      include: { offer: { select: { employment_types: true } } },
    })
    console.log(`[trigger-sync] fetched ${existingOffers.length} pending_apply/ai_rejected offers to recalculate`)

    let keptCount = 0
    let rejectedCount = 0

    for (const uo of existingOffers) {
      const salaryResult = calculateUserOfferSalary(
        Array.isArray(uo.offer.employment_types) ? uo.offer.employment_types : [],
        preferredCurrency,
        salaryPrefs,
        exchangeRates,
      )
      const bestDelta = Math.max(
        salaryResult?.contract?.delta ?? -Infinity,
        salaryResult?.permanent?.delta ?? -Infinity,
      )
      const newContractDelta = salaryResult?.contract?.delta ?? null
      console.log(
        `[trigger-sync] offer ${uo.offer_id}: old_contract_delta=${uo.salary_contract_delta} new_contract_delta=${newContractDelta} → ${!salaryResult || bestDelta < 0 ? 'pre_filter_rejected' : 'kept'}`,
      )

      if (!salaryResult || bestDelta < 0) {
        await prisma.userOffer.update({
          where: { id: uo.id },
          data: { status: 'pre_filter_rejected', salary_contract_delta: null, salary_permanent_delta: null },
        })
        rejectedCount++
      } else {
        await prisma.userOffer.update({
          where: { id: uo.id },
          data: {
            salary_contract_delta: salaryResult.contract?.delta ?? null,
            salary_permanent_delta: salaryResult.permanent?.delta ?? null,
            salary_currency: salaryResult.salary_currency,
          },
        })
        keptCount++
      }
    }
    return [keptCount, rejectedCount]
  }

  // ── Step 3: salary-only increase — partial re-sync, no Claude ─────────────────
  if (isSalaryOnlyChange && salaryOnlyIncreased) {
    console.log('[trigger-sync] salary-only increase — partial re-sync (no Claude)')

    const ratesSetting = await prisma.settings.findUnique({ where: { key: 'exchange_rates' } })
    const exchangeRates: Record<string, number> = ratesSetting
      ? (JSON.parse(ratesSetting.value) as Record<string, number>)
      : {}
    const preferredCurrency = user.preferred_currency ?? 'USD'

    const [keptCount, rejectedCount] = await recalculateSalaryDeltas(newPrefs, exchangeRates, preferredCurrency)
    console.log(`[trigger-sync] salary-only increase: kept ${keptCount} offers, rejected ${rejectedCount} offers`)

    await buildAndSaveFreePlanSnapshot(userId, newPrefs, exchangeRates, user.profile)
    console.log('[trigger-sync] salary-only increase: snapshot rebuilt')

    await prisma.user.update({
      where: { id: userId },
      data: { profile_synced_at: new Date(), sync_started_at: null, profile_editing_snapshot: Prisma.JsonNull },
    })

    return res.status(200).json({ success: true, partial: true })
  }

  // ── Step 4: salary-only decrease — partial re-sync, Claude for new qualifiers ─
  if (isSalaryOnlyChange && !salaryOnlyIncreased) {
    console.log('[trigger-sync] salary min decreased — partial re-sync with Claude for newly qualifying offers')
    console.log(`[trigger-sync] old salary prefs: ${JSON.stringify(oldPrefs)}`)
    console.log(`[trigger-sync] new salary prefs: ${JSON.stringify(newPrefs)}`)

    const [ratesSetting, preFilterRejectedRows] = await Promise.all([
      prisma.settings.findUnique({ where: { key: 'exchange_rates' } }),
      prisma.userOffer.findMany({
        where: { user_id: userId, status: 'pre_filter_rejected' },
        include: { offer: true },
      }),
    ])
    const exchangeRates: Record<string, number> = ratesSetting
      ? (JSON.parse(ratesSetting.value) as Record<string, number>)
      : {}
    const preferredCurrency = user.preferred_currency ?? 'USD'

    // Find pre_filter_rejected offers that now pass all filters under the new profile
    const profileParsed = CandidateProfileSchema.safeParse(user.profile)
    const qualifyingIds: string[] = []
    if (profileParsed.success) {
      for (const uo of preFilterRejectedRows) {
        if (applyPreFilters(profileParsed.data, uo.offer).pass) {
          qualifyingIds.push(uo.id)
        }
      }
    }
    console.log(`[trigger-sync] salary decreased: found ${preFilterRejectedRows.length} pre_filter_rejected offers, ${qualifyingIds.length} now qualify for Claude`)

    // Delete qualifying pre_filter_rejected rows — syncUserById picks them up as unseens
    if (qualifyingIds.length > 0) {
      await prisma.userOffer.deleteMany({ where: { id: { in: qualifyingIds } } })
    }

    // Recalculate deltas for existing pending_apply/ai_rejected
    const [keptCount, rejectedCount] = await recalculateSalaryDeltas(newPrefs, exchangeRates, preferredCurrency)
    console.log(`[trigger-sync] salary decreased: recalculated deltas for ${keptCount + rejectedCount} existing offers`)

    await buildAndSaveFreePlanSnapshot(userId, newPrefs, exchangeRates, user.profile)
    console.log('[trigger-sync] salary decreased: snapshot rebuilt')

    await prisma.user.update({
      where: { id: userId },
      data: { profile_synced_at: new Date(), profile_editing_snapshot: Prisma.JsonNull },
    })

    await prisma.notificationLock.deleteMany({
      where: { lock_key: { startsWith: `sync:${userId}` } },
    })

    res.status(202).json({ success: true, partial: true })

    // Background: Claude matching for newly qualifying offers (syncUserById sees
    // them as unseens because their pre_filter_rejected rows were deleted above).
    syncUserById(userId).catch(err =>
      console.error(`[trigger-sync] Partial salary sync failed for user ${userId}:`, err),
    )
    return
  }

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
