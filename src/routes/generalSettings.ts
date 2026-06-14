import { Router } from 'express'
import Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { env } from '../lib/env'

export const generalSettingsRouter = Router()

generalSettingsRouter.get('/', async (_req, res) => {
  const row = await prisma.settings.findUnique({
    where: { key: 'general_settings' },
  })

  if (!row) {
    throw new AppError(500, 'INTERNAL_ERROR', 'general_settings not found in settings table')
  }

  const parsed = JSON.parse(row.value) as Record<string, unknown>

  // DB row: INSERT INTO settings (key, value) VALUES ('stripe_price_ids', '{"scan_package_price_id": "price_1TiC6o0BpUQ7vRlQO79GoNZu"}')
  let proPrice: { amount: number; currency: string; formatted: string } | null = null
  let scanPackagePrice: { amount: number; currency: string; formatted: string } | null = null
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY)

    const [plan, priceIdsSetting] = await Promise.all([
      prisma.plan.findUnique({ where: { name: 'pro' }, select: { stripe_price_id: true } }),
      prisma.settings.findUnique({ where: { key: 'stripe_price_ids' } }),
    ])

    const priceIds = JSON.parse(priceIdsSetting?.value ?? '{}') as Record<string, string>
    const scanPackagePriceId = priceIds['scan_package_price_id'] ?? null

    const [proStripePrice, scanStripePrice] = await Promise.all([
      plan?.stripe_price_id ? stripe.prices.retrieve(plan.stripe_price_id) : Promise.resolve(null),
      scanPackagePriceId ? stripe.prices.retrieve(scanPackagePriceId) : Promise.resolve(null),
    ])

    if (proStripePrice?.unit_amount != null) {
      const dollars = proStripePrice.unit_amount / 100
      proPrice = {
        amount: proStripePrice.unit_amount,
        currency: proStripePrice.currency,
        formatted: dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`,
      }
    }

    if (scanStripePrice?.unit_amount != null) {
      const dollars = scanStripePrice.unit_amount / 100
      scanPackagePrice = {
        amount: scanStripePrice.unit_amount,
        currency: scanStripePrice.currency,
        formatted: dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`,
      }
    }
  } catch {
    proPrice = null
    scanPackagePrice = null
  }

  parsed.pro_price = proPrice
  parsed.scan_package_price = scanPackagePrice

  res.json(parsed)
})
