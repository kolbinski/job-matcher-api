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

  // Pre-step: Prevent the scheduler from re-queueing and signal any in-flight sync to abort
  await prisma.user.update({ where: { id: targetUserId }, data: { profile_ready: false, sync_started_at: null } })
  await new Promise<void>(resolve => setTimeout(resolve, 500))

  // Step 1: Batch-delete user_offer_statuses (via raw SQL to support LIMIT)
  while (true) {
    const affected = await prisma.$executeRaw`
      DELETE FROM user_offer_statuses WHERE id IN (
        SELECT uos.id FROM user_offer_statuses uos
        JOIN user_offers uo ON uos.user_offer_id = uo.id
        WHERE uo.user_id = ${targetUserId}
        LIMIT 1000
      )`
    if (affected === 0) break
  }

  // Step 2: Batch-delete user_offers
  while (true) {
    const affected = await prisma.$executeRaw`
      DELETE FROM user_offers WHERE id IN (
        SELECT id FROM user_offers WHERE user_id = ${targetUserId} LIMIT 1000
      )`
    if (affected === 0) break
  }

  // Step 3: Delete remaining FK-constrained records (small counts — no batching needed)
  await prisma.pushToken.deleteMany({ where: { user_id: targetUserId } })
  await prisma.agentClient.deleteMany({ where: { user_id: targetUserId } })
  await prisma.feedback.deleteMany({ where: { user_id: targetUserId } })
  await prisma.userSync.deleteMany({ where: { user_id: targetUserId } })
  await prisma.notificationLock.deleteMany({ where: { lock_key: { contains: targetUserId } } })
  await prisma.apiCall.deleteMany({ where: { user_id: targetUserId } })
  await prisma.subscription.deleteMany({ where: { user_id: targetUserId } })

  // Step 4: Delete CV and CL files from Supabase Storage (best-effort — don't block account deletion)
  try {
    const sanitizedEmail = targetEmail.replace(/@/g, '_at_').replace(/\./g, '_').replace(/\+/g, '_')
    const supabase = getSupabase()
    const [{ data: cvFiles }, { data: clFiles }] = await Promise.all([
      supabase.storage.from('homo-digital').list(`cvs/${sanitizedEmail}`),
      supabase.storage.from('homo-digital').list(`cls/${sanitizedEmail}`),
    ])
    const pathsToDelete = [
      ...(cvFiles ?? []).map(f => `cvs/${sanitizedEmail}/${f.name}`),
      ...(clFiles ?? []).map(f => `cls/${sanitizedEmail}/${f.name}`),
    ]
    if (pathsToDelete.length > 0) {
      const { error } = await supabase.storage.from('homo-digital').remove(pathsToDelete)
      if (error) console.error(`[delete-account] Storage deletion failed for ${sanitizedEmail}:`, error)
    }
  } catch (err) {
    console.error('[delete-account] Storage cleanup error:', err)
  }

  // Step 5: Delete the user row
  await prisma.user.delete({ where: { id: targetUserId } })

  // Step 6: Delete from Supabase auth (best-effort — password-login users may have no Supabase entry)
  const supabaseUid = await findSupabaseUserId(targetEmail)
  if (supabaseUid) {
    const { error } = await getSupabase().auth.admin.deleteUser(supabaseUid)
    if (error) console.error(`[delete-account] Supabase deleteUser failed for ${supabaseUid}:`, error)
  }

  res.status(200).json({ message: 'Account deleted' })
})
