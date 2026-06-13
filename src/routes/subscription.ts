import { Router } from 'express'
import Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { env } from '../lib/env'

let _stripe: InstanceType<typeof Stripe> | null = null
function getStripe(): InstanceType<typeof Stripe> {
  if (!_stripe) _stripe = new Stripe(env.STRIPE_SECRET_KEY)
  return _stripe
}

export const subscriptionRouter = Router()

subscriptionRouter.get('/status', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const subscription = await prisma.subscription.findFirst({
    where: { user_id: user_id! },
    include: { plan: { select: { name: true } } },
  })

  return res.json({
    subscribed_to: subscription?.current_period_end ?? null,
    plan_name: subscription?.plan.name ?? 'free',
    current_period_end: subscription?.current_period_end ?? null,
  })
})

subscriptionRouter.post('/checkout', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  })
  if (!user) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' })
  }

  const proPlan = await prisma.plan.findUnique({ where: { name: 'pro' } })
  if (!proPlan?.stripe_price_id) {
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Pro plan not configured with a Stripe price' })
  }

  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: proPlan.stripe_price_id, quantity: 1 }],
    success_url: 'https://homodigital.io?upgrade=success',
    cancel_url: 'https://homodigital.io?upgrade=cancelled',
    client_reference_id: userId,
    customer_email: user.email,
  })

  return res.json({ url: session.url })
})

subscriptionRouter.post('/cancel', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const subscription = await prisma.subscription.findFirst({
    where: { user_id: userId, status: 'active' },
    include: { plan: { select: { name: true } } },
  })

  if (!subscription || subscription.plan.name === 'free' || !subscription.stripe_subscription_id) {
    return res.status(400).json({ error: 'NO_ACTIVE_SUBSCRIPTION' })
  }

  await getStripe().subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: true,
  })

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: 'cancelling' },
  })

  return res.json({ success: true, current_period_end: subscription.current_period_end })
})
