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

  let proPrice: { amount: number; currency: string; formatted: string } | null = null
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY)
    const plan = await prisma.plan.findUnique({
      where: { name: 'pro' },
      select: { stripe_price_id: true },
    })
    if (plan?.stripe_price_id) {
      const price = await stripe.prices.retrieve(plan.stripe_price_id)
      if (price.unit_amount != null) {
        const dollars = price.unit_amount / 100
        const formatted = dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`
        proPrice = {
          amount: price.unit_amount,
          currency: price.currency,
          formatted,
        }
      }
    }
  } catch {
    proPrice = null
  }

  parsed.pro_price = proPrice

  res.json(parsed)
})
