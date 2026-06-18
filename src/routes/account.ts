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

const DeleteReasonsSchema = z.object({
  reasons: z.array(z.string()),
})

const DeleteFeedbackSchema = z.object({
  feedback: z.string(),
})

// Find or create the user_deleted offboarding row for a user. There is no unique
// constraint on user_id, so we look it up explicitly rather than upsert.
async function findOrCreateUserDeleted(userId: string, email: string): Promise<string> {
  const existing = await prisma.userDeleted.findFirst({ where: { user_id: userId } })
  if (existing) return existing.id
  const created = await prisma.userDeleted.create({ data: { user_id: userId, email } })
  return created.id
}

accountRouter.post('/delete-reasons', validateJwt, async (req, res) => {
  const { role, user_id, email } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const parsed = DeleteReasonsSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid body' })
  }

  const id = await findOrCreateUserDeleted(user_id!, email)
  await prisma.userDeleted.update({
    where: { id },
    data: { delete_reasons: parsed.data.reasons },
  })

  return res.json({ success: true })
})

accountRouter.post('/delete-feedback', validateJwt, async (req, res) => {
  const { role, user_id, email } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const parsed = DeleteFeedbackSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid body' })
  }

  const id = await findOrCreateUserDeleted(user_id!, email)
  await prisma.userDeleted.update({
    where: { id },
    data: { feedback: parsed.data.feedback },
  })

  return res.json({ success: true })
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

  // Step 1: Delete from Supabase auth (before public.users so JWT lookups still work)
  const supabaseUid = await findSupabaseUserId(targetEmail)
  if (supabaseUid) {
    console.log(`[delete-account] Deleting auth.users entry supabaseUid=${supabaseUid}`)
    const { error } = await getSupabase().auth.admin.deleteUser(supabaseUid)
    if (error) console.error(`[delete-account] Supabase deleteUser failed for ${supabaseUid}:`, error)
    else console.log(`[delete-account] auth.users entry deleted`)
  } else {
    console.log(`[delete-account] No Supabase auth user found for email=${targetEmail} — skipping`)
  }

  // Step 2: Delete public.users row — CASCADE handles all FK-linked tables
  console.log(`[delete-account] Deleting public.users row for ${targetUserId}`)
  try {
    await prisma.user.delete({ where: { id: targetUserId } })
    console.log(`[delete-account] public.users row deleted — cascade complete`)
  } catch (e: unknown) {
    const msg = typeof e === 'object' && e !== null && 'message' in e ? (e as { message: string }).message : String(e)
    const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code: string }).code : undefined
    console.error('[delete-account] FAILED to delete public.users row:', msg, code)
    throw e
  }

  // Step 3: Delete CV and CL files from Supabase Storage (best-effort)
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
      else console.log(`[delete-account] Deleted ${pathsToDelete.length} storage file(s)`)
    }
  } catch (err) {
    console.error('[delete-account] Storage cleanup error:', err)
  }

  console.log(`[delete-account] Done — account fully deleted for ${targetUserId}`)
  res.status(200).json({ message: 'Account deleted' })
})
