import { Router } from 'express'
import { z } from 'zod'
import Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { getSupabase } from '../lib/supabase'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'

let _stripe: InstanceType<typeof Stripe> | null = null
function getStripe(): InstanceType<typeof Stripe> {
  if (!_stripe) _stripe = new Stripe(env.STRIPE_SECRET_KEY)
  return _stripe
}

export const accountRouter = Router()

const AgentBodySchema = z.object({
  client_id: z.string().uuid(),
})

const AccountSettingsUpdateSchema = z.object({
  timezone: z.string().optional(),
  preferred_currency: z.string().optional(),
})

accountRouter.get('/settings', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const user = await prisma.user.findUnique({
    where: { id: user_id! },
    select: { timezone: true, preferred_currency: true },
  })
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found')

  return res.json({ timezone: user.timezone, preferred_currency: user.preferred_currency })
})

accountRouter.patch('/settings', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const parsed = AccountSettingsUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid body' })
  }

  const { timezone, preferred_currency } = parsed.data
  const updated = await prisma.user.update({
    where: { id: user_id! },
    data: {
      ...(timezone !== undefined ? { timezone } : {}),
      ...(preferred_currency !== undefined ? { preferred_currency } : {}),
    },
    select: { timezone: true, preferred_currency: true },
  })

  return res.json({ timezone: updated.timezone, preferred_currency: updated.preferred_currency })
})

const BillingUpdateSchema = z.object({
  name: z.string().optional(),
  line1: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
})

accountRouter.get('/billing', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const user = await prisma.user.findUnique({
    where: { id: user_id! },
    select: { stripe_customer_id: true },
  })

  if (!user?.stripe_customer_id) {
    return res.json({ billing_data: null })
  }

  const customer = await getStripe().customers.retrieve(user.stripe_customer_id)
  if (customer.deleted) {
    return res.json({ billing_data: null })
  }

  return res.json({
    billing_data: {
      name: customer.name ?? null,
      email: customer.email ?? null,
      address: customer.address ?? null,
    },
  })
})

accountRouter.patch('/billing', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const parsed = BillingUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid body' })
  }

  const user = await prisma.user.findUnique({
    where: { id: user_id! },
    select: { stripe_customer_id: true },
  })

  if (!user?.stripe_customer_id) {
    return res.status(400).json({ error: 'NO_STRIPE_CUSTOMER' })
  }

  const { name, line1, city, postal_code, country } = parsed.data

  const updated = await getStripe().customers.update(user.stripe_customer_id, {
    ...(name !== undefined ? { name } : {}),
    address: { line1: line1 ?? '', city: city ?? '', postal_code: postal_code ?? '', country: country ?? '' },
  })

  return res.json({
    billing_data: {
      name: updated.name ?? null,
      email: updated.email ?? null,
      address: updated.address ?? null,
    },
  })
})

async function findSupabaseUserId(email: string): Promise<string | null> {
  let page = 1
  const perPage = 1000
  while (true) {
    const { data, error } = await getSupabase().auth.admin.listUsers({ page, perPage })
    if (error || !data) return null
    const match = data.users.find(u => u.email === email)
    if (match) return match.id
    if (data.users.length < perPage) return null
    page++
  }
}

accountRouter.delete('/', validateJwt, async (req, res) => {
  let targetUserId: string
  let targetEmail: string

  if (req.jwt!.role === 'agent') {
    const parsed = AgentBodySchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError(422, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'client_id is required')
    }
    const { client_id } = parsed.data

    const link = await prisma.agentClient.findUnique({
      where: { agent_id_user_id: { agent_id: req.jwt!.agent_id!, user_id: client_id } },
    })
    if (!link) throw new AppError(403, 'FORBIDDEN', 'Agent does not have access to this client')

    const user = await prisma.user.findUnique({
      where: { id: client_id },
      select: { id: true, email: true },
    })
    if (!user) throw new AppError(404, 'NOT_FOUND', 'Client not found')

    targetUserId = user.id
    targetEmail = user.email
  } else {
    const user = await prisma.user.findUnique({
      where: { id: req.jwt!.user_id! },
      select: { id: true, email: true },
    })
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found')

    targetUserId = user.id
    targetEmail = user.email
  }

  console.log(`[delete-account] Starting deletion for user_id=${targetUserId} email=${targetEmail}`)

  // Pre-step: Prevent the scheduler from re-queueing and signal any in-flight sync to abort
  console.log(`[delete-account] Pre-step: disabling profile_ready for ${targetUserId}`)
  await prisma.user.update({ where: { id: targetUserId }, data: { profile_ready: false, sync_started_at: null } })
  await new Promise<void>(resolve => setTimeout(resolve, 500))

  // Step 1: Batch-delete user_offer_statuses (via raw SQL to support LIMIT)
  console.log(`[delete-account] Step 1: deleting user_offer_statuses for ${targetUserId}`)
  while (true) {
    const affected = await prisma.$executeRaw`
      DELETE FROM user_offer_statuses WHERE id IN (
        SELECT uos.id FROM user_offer_statuses uos
        JOIN user_offers uo ON uos.user_offer_id = uo.id
        WHERE uo.user_id = ${targetUserId}
        LIMIT 1000
      )`
    if (affected === 0) break
    console.log(`[delete-account] Step 1: deleted ${affected} user_offer_statuses rows`)
  }

  // Step 2: Batch-delete user_offers
  console.log(`[delete-account] Step 2: deleting user_offers for ${targetUserId}`)
  while (true) {
    const affected = await prisma.$executeRaw`
      DELETE FROM user_offers WHERE id IN (
        SELECT id FROM user_offers WHERE user_id = ${targetUserId} LIMIT 1000
      )`
    if (affected === 0) break
    console.log(`[delete-account] Step 2: deleted ${affected} user_offers rows`)
  }

  // Step 3: Delete remaining FK-constrained records (small counts — no batching needed)
  console.log(`[delete-account] Step 3: deleting push_tokens for ${targetUserId}`)
  await prisma.pushToken.deleteMany({ where: { user_id: targetUserId } })
  console.log(`[delete-account] Step 3: deleting agent_clients for ${targetUserId}`)
  await prisma.agentClient.deleteMany({ where: { user_id: targetUserId } })
  console.log(`[delete-account] Step 3: deleting feedbacks for ${targetUserId}`)
  await prisma.feedback.deleteMany({ where: { user_id: targetUserId } })
  console.log(`[delete-account] Step 3: deleting user_syncs for ${targetUserId}`)
  await prisma.userSync.deleteMany({ where: { user_id: targetUserId } })
  console.log(`[delete-account] Step 3: deleting notification_locks for ${targetUserId}`)
  await prisma.notificationLock.deleteMany({ where: { lock_key: { contains: targetUserId } } })
  console.log(`[delete-account] Step 3: deleting api_calls for ${targetUserId}`)
  await prisma.apiCall.deleteMany({ where: { user_id: targetUserId } })
  console.log(`[delete-account] Step 3: deleting subscriptions for ${targetUserId}`)
  await prisma.subscription.deleteMany({ where: { user_id: targetUserId } })
  console.log(`[delete-account] Step 3: all FK-constrained records deleted for ${targetUserId}`)

  // Step 4: Delete CV and CL files from Supabase Storage (best-effort — don't block account deletion)
  console.log(`[delete-account] Step 4: deleting storage files for ${targetUserId}`)
  try {
    const supabase = getSupabase()
    const [{ data: cvFiles }, { data: clFiles }] = await Promise.all([
      supabase.storage.from('homo-digital').list(`cvs/${targetUserId}`),
      supabase.storage.from('homo-digital').list(`cls/${targetUserId}`),
    ])
    const pathsToDelete = [
      ...(cvFiles ?? []).map(f => `cvs/${targetUserId}/${f.name}`),
      ...(clFiles ?? []).map(f => `cls/${targetUserId}/${f.name}`),
    ]
    if (pathsToDelete.length > 0) {
      const { error } = await supabase.storage.from('homo-digital').remove(pathsToDelete)
      if (error) console.error(`[delete-account] Storage deletion failed for ${targetUserId}:`, error)
      else console.log(`[delete-account] Step 4: deleted ${pathsToDelete.length} storage file(s)`)
    } else {
      console.log(`[delete-account] Step 4: no storage files found`)
    }
  } catch (err) {
    console.error('[delete-account] Storage cleanup error:', err)
  }

  // Step 5: Delete the user row from public.users
  console.log(`[delete-account] Step 5: deleting public.users row for ${targetUserId}`)
  try {
    await prisma.user.delete({ where: { id: targetUserId } })
    console.log(`[delete-account] Step 5: public.users row deleted for ${targetUserId}`)
  } catch (err) {
    console.error(`[delete-account] Step 5 FAILED — could not delete public.users row for ${targetUserId}:`, err)
    throw err
  }

  // Step 6: Delete from Supabase auth (best-effort — password-login users may have no Supabase entry)
  console.log(`[delete-account] Step 6: looking up Supabase auth user for email=${targetEmail}`)
  const supabaseUid = await findSupabaseUserId(targetEmail)
  if (supabaseUid) {
    console.log(`[delete-account] Step 6: deleting auth.users entry supabaseUid=${supabaseUid}`)
    const { error } = await getSupabase().auth.admin.deleteUser(supabaseUid)
    if (error) console.error(`[delete-account] Step 6 FAILED — Supabase deleteUser failed for ${supabaseUid}:`, error)
    else console.log(`[delete-account] Step 6: auth.users entry deleted for ${supabaseUid}`)
  } else {
    console.log(`[delete-account] Step 6: no Supabase auth user found for email=${targetEmail} — skipping`)
  }

  console.log(`[delete-account] Done — account fully deleted for ${targetUserId}`)
  res.status(200).json({ message: 'Account deleted' })
})
