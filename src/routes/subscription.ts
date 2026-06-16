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

  const [subscription, user] = await Promise.all([
    prisma.subscription.findFirst({
      where: { user_id: user_id! },
      include: { plan: { select: { name: true } } },
    }),
    prisma.user.findUnique({
      where: { id: user_id! },
      select: { cv_counter: true, cv_counter_max: true, cl_counter: true, cl_counter_max: true, scan_page_counter: true, scan_page_counter_max: true, profile_relevant_change_counter: true, profile_relevant_change_counter_max: true, profile_relevant_change_pending: true, review_by_ai_counter: true, review_by_ai_counter_max: true, is_admin: true },
    }),
  ])

  const isFree = !subscription || subscription.plan.name === 'free'
  const status = isFree ? 'free' : (subscription.status === 'cancelling' ? 'cancelling' : 'active')

  return res.json({
    subscribed_to: subscription?.current_period_end ?? null,
    plan_name: subscription?.plan.name ?? 'free',
    current_period_end: subscription?.current_period_end ?? null,
    status,
    cv_counter: user?.cv_counter ?? 0,
    cv_counter_max: user?.cv_counter_max ?? 0,
    cl_counter: user?.cl_counter ?? 0,
    cl_counter_max: user?.cl_counter_max ?? 0,
    scan_page_counter: user?.scan_page_counter ?? 0,
    scan_page_counter_max: user?.scan_page_counter_max ?? 0,
    profile_relevant_change_counter: user?.profile_relevant_change_counter ?? 0,
    profile_relevant_change_counter_max: user?.profile_relevant_change_counter_max ?? 0,
    profile_relevant_change_pending: user?.profile_relevant_change_pending ?? false,
    review_by_ai_counter: user?.review_by_ai_counter ?? 0,
    review_by_ai_counter_max: user?.review_by_ai_counter_max ?? 0,
    is_admin: user?.is_admin ?? false,
  })
})

subscriptionRouter.post('/checkout', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const [user, proPlan] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, stripe_customer_id: true } }),
    prisma.plan.findUnique({ where: { name: 'pro' } }),
  ])
  if (!user) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' })
  }
  if (!proPlan?.stripe_price_id) {
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Pro plan not configured with a Stripe price' })
  }

  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: proPlan.stripe_price_id, quantity: 1 }],
    success_url: 'https://homodigital.io?upgrade=success',
    cancel_url: 'https://homodigital.io?upgrade=cancelled',
    client_reference_id: userId,
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    ...(user.stripe_customer_id
      ? { customer: user.stripe_customer_id, customer_update: { address: 'auto', name: 'auto' } }
      : { customer_email: user.email }),
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

subscriptionRouter.post('/renew', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const subscription = await prisma.subscription.findFirst({
    where: { user_id: userId, status: 'cancelling' },
  })

  if (!subscription || !subscription.stripe_subscription_id) {
    return res.status(400).json({ error: 'NO_CANCELLING_SUBSCRIPTION' })
  }

  await getStripe().subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: false,
  })

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: 'active' },
  })

  return res.json({ success: true })
})

subscriptionRouter.post('/cv-package-checkout', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const [priceIdsSetting, generalSetting, user] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'stripe_price_ids' } }),
    prisma.settings.findUnique({ where: { key: 'general_settings' } }),
    prisma.user.findUnique({ where: { id: userId }, select: { stripe_customer_id: true, email: true } }),
  ])

  const priceIds = JSON.parse(priceIdsSetting?.value ?? '{}') as Record<string, string>
  const cvPackagePriceId = priceIds['cv_package_price_id']
  if (!cvPackagePriceId) {
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'cv_package_price_id not configured' })
  }

  const generalSettings = JSON.parse(generalSetting?.value ?? '{}') as Record<string, unknown>
  const amount = Number(generalSettings['cv_package_amount'] ?? 0)

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    currency: 'usd',
    line_items: [{ price: cvPackagePriceId, quantity: 1 }],
    metadata: { type: 'cv_package', user_id: userId, amount: String(amount) },
    success_url: 'https://homodigital.io?upgrade=cv_package',
    cancel_url: 'https://homodigital.io?upgrade=cancelled',
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    ...(user?.stripe_customer_id
      ? { customer: user.stripe_customer_id, customer_update: { address: 'auto', name: 'auto' } }
      : { customer_email: user?.email, customer_creation: 'always' }),
  })

  return res.json({ url: session.url })
})

subscriptionRouter.post('/cl-package-checkout', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const [priceIdsSetting, generalSetting, user] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'stripe_price_ids' } }),
    prisma.settings.findUnique({ where: { key: 'general_settings' } }),
    prisma.user.findUnique({ where: { id: userId }, select: { stripe_customer_id: true, email: true } }),
  ])

  const priceIds = JSON.parse(priceIdsSetting?.value ?? '{}') as Record<string, string>
  const clPackagePriceId = priceIds['cl_package_price_id']
  if (!clPackagePriceId) {
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'cl_package_price_id not configured' })
  }

  const generalSettings = JSON.parse(generalSetting?.value ?? '{}') as Record<string, unknown>
  const amount = Number(generalSettings['cl_package_amount'] ?? 0)

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    currency: 'usd',
    line_items: [{ price: clPackagePriceId, quantity: 1 }],
    metadata: { type: 'cl_package', user_id: userId, amount: String(amount) },
    success_url: 'https://homodigital.io?upgrade=cl_package',
    cancel_url: 'https://homodigital.io?upgrade=cancelled',
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    ...(user?.stripe_customer_id
      ? { customer: user.stripe_customer_id, customer_update: { address: 'auto', name: 'auto' } }
      : { customer_email: user?.email, customer_creation: 'always' }),
  })

  return res.json({ url: session.url })
})

subscriptionRouter.post('/profile-rematch-checkout', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const [priceIdsSetting, generalSetting, user] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'stripe_price_ids' } }),
    prisma.settings.findUnique({ where: { key: 'general_settings' } }),
    prisma.user.findUnique({ where: { id: userId }, select: { stripe_customer_id: true, email: true } }),
  ])

  const priceIds = JSON.parse(priceIdsSetting?.value ?? '{}') as Record<string, string>
  const profileRematchPriceId = priceIds['profile_rematch_package_price_id']
  if (!profileRematchPriceId) {
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'profile_rematch_package_price_id not configured' })
  }

  const generalSettings = JSON.parse(generalSetting?.value ?? '{}') as Record<string, unknown>
  const amount = Number(generalSettings['profile_relevant_change_package_amount'] ?? 0)

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: profileRematchPriceId, quantity: 1 }],
    metadata: { type: 'profile_rematch_package', user_id: userId, amount: String(amount) },
    success_url: 'https://homodigital.io?upgrade=profile_rematch_package',
    cancel_url: 'https://homodigital.io?upgrade=cancelled',
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    payment_intent_data: { description: 'Homo Digital 10 Profile Re-match Package' },
    ...(user?.stripe_customer_id
      ? { customer: user.stripe_customer_id, customer_update: { address: 'auto', name: 'auto' } }
      : { customer_email: user?.email, customer_creation: 'always' }),
  })

  return res.json({ url: session.url })
})

subscriptionRouter.post('/review-package-checkout', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const [priceIdsSetting, generalSetting, user] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'stripe_price_ids' } }),
    prisma.settings.findUnique({ where: { key: 'general_settings' } }),
    prisma.user.findUnique({ where: { id: userId }, select: { stripe_customer_id: true, email: true } }),
  ])

  const priceIds = JSON.parse(priceIdsSetting?.value ?? '{}') as Record<string, string>
  const reviewPackagePriceId = priceIds['profile_review_package_price_id']
  if (!reviewPackagePriceId) {
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'profile_review_package_price_id not configured' })
  }

  const generalSettings = JSON.parse(generalSetting?.value ?? '{}') as Record<string, unknown>
  const amount = Number(generalSettings['profile_review_package_amount'] ?? 0)

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: reviewPackagePriceId, quantity: 1 }],
    metadata: { type: 'review_package', user_id: userId, amount: String(amount) },
    success_url: 'https://homodigital.io?upgrade=review_package',
    cancel_url: 'https://homodigital.io?upgrade=cancelled',
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    payment_intent_data: { description: 'Homo Digital 10 Profile Reviews Package' },
    ...(user?.stripe_customer_id
      ? { customer: user.stripe_customer_id, customer_update: { address: 'auto', name: 'auto' } }
      : { customer_email: user?.email, customer_creation: 'always' }),
  })

  return res.json({ url: session.url })
})

subscriptionRouter.post('/scan-package-checkout', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const [priceIdsSetting, generalSetting, user] = await Promise.all([
    prisma.settings.findUnique({ where: { key: 'stripe_price_ids' } }),
    prisma.settings.findUnique({ where: { key: 'general_settings' } }),
    prisma.user.findUnique({ where: { id: userId }, select: { stripe_customer_id: true, email: true } }),
  ])

  const priceIds = JSON.parse(priceIdsSetting?.value ?? '{}') as Record<string, string>
  const scanPackagePriceId = priceIds['scan_package_price_id']
  if (!scanPackagePriceId) {
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'scan_package_price_id not configured' })
  }

  const generalSettings = JSON.parse(generalSetting?.value ?? '{}') as Record<string, unknown>
  const packagePageScansAmount = Number(generalSettings['package_page_scans_amount'] ?? 0)

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    currency: 'usd',
    line_items: [{ price: scanPackagePriceId, quantity: 1 }],
    metadata: {
      type: 'scan_package',
      user_id: userId,
      amount: String(packagePageScansAmount),
    },
    success_url: 'https://homodigital.io?upgrade=scan_package',
    cancel_url: 'https://homodigital.io?upgrade=cancelled',
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    ...(user?.stripe_customer_id
      ? { customer: user.stripe_customer_id, customer_update: { address: 'auto', name: 'auto' } }
      : { customer_email: user?.email, customer_creation: 'always' }),
  })

  return res.json({ url: session.url })
})
