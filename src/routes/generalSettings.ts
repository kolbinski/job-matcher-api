import { Router } from 'express'
import Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'

export const generalSettingsRouter = Router()

type PriceInfo = { amount: number; currency: string; formatted: string } | null
type StripePrice = Awaited<ReturnType<InstanceType<typeof Stripe>['prices']['retrieve']>>

function formatStripePrice(price: StripePrice | null): PriceInfo {
  if (price?.unit_amount == null) return null
  const dollars = price.unit_amount / 100
  return {
    amount: price.unit_amount,
    currency: price.currency,
    formatted: dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`,
  }
}

generalSettingsRouter.get('/', async (_req, res) => {
  const row = await prisma.settings.findUnique({
    where: { key: 'general_settings' },
  })

  if (!row) {
    throw new AppError(500, 'INTERNAL_ERROR', 'general_settings not found in settings table')
  }

  const parsed = JSON.parse(row.value) as Record<string, unknown>

  const stripe = new Stripe(env.STRIPE_SECRET_KEY)

  const [plan, priceIdsSetting, allPlans] = await Promise.all([
    prisma.plan.findUnique({ where: { name: 'pro' }, select: { stripe_price_id: true } }),
    prisma.settings.findUnique({ where: { key: 'stripe_price_ids' } }),
    prisma.plan.findMany({ select: { name: true, limits: true } }).catch(() => null),
  ])

  const priceIds = JSON.parse(priceIdsSetting?.value ?? '{}') as Record<string, string>
  const scanPackagePriceId = priceIds['scan_package_price_id'] ?? null
  const cvPackagePriceId = priceIds['cv_package_price_id'] ?? null
  const clPackagePriceId = priceIds['cl_package_price_id'] ?? null

  const [proStripePrice, scanStripePrice, cvStripePrice, clStripePrice] = await Promise.all([
    plan?.stripe_price_id ? stripe.prices.retrieve(plan.stripe_price_id).catch(() => null) : Promise.resolve(null),
    scanPackagePriceId ? stripe.prices.retrieve(scanPackagePriceId).catch(() => null) : Promise.resolve(null),
    cvPackagePriceId ? stripe.prices.retrieve(cvPackagePriceId).catch(() => null) : Promise.resolve(null),
    clPackagePriceId ? stripe.prices.retrieve(clPackagePriceId).catch(() => null) : Promise.resolve(null),
  ])

  parsed.pro_price = formatStripePrice(proStripePrice)
  parsed.scan_package_price = formatStripePrice(scanStripePrice)
  parsed.cv_package_price = formatStripePrice(cvStripePrice)
  parsed.cl_package_price = formatStripePrice(clStripePrice)
  parsed.plans = allPlans
    ? Object.fromEntries(allPlans.map(p => [p.name, p.limits]))
    : null

  res.json(parsed)
})
