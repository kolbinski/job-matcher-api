import { Router } from 'express'
import Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { env } from '../lib/env'

export const billingRouter = Router()

let _stripe: InstanceType<typeof Stripe> | null = null
function getStripe(): InstanceType<typeof Stripe> {
  if (!_stripe) _stripe = new Stripe(env.STRIPE_SECRET_KEY)
  return _stripe
}

type StripeInvoice = Awaited<ReturnType<InstanceType<typeof Stripe>['invoices']['list']>>['data'][number]
type StripePaymentIntent = Awaited<ReturnType<InstanceType<typeof Stripe>['paymentIntents']['list']>>['data'][number]

billingRouter.get('/history', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }

  const user = await prisma.user.findUnique({
    where: { id: user_id! },
    select: { stripe_customer_id: true },
  })

  if (!user?.stripe_customer_id) {
    return res.json({ history: [] })
  }

  const customerId = user.stripe_customer_id
  const stripe = getStripe()

  const [invoicesResult, paymentIntentsResult] = await Promise.all([
    stripe.invoices.list({ customer: customerId, limit: 20 }).catch(() => null),
    stripe.paymentIntents.list({ customer: customerId, limit: 20 }).catch(() => null),
  ])

  const invoiceItems = (invoicesResult?.data ?? []).map((inv: StripeInvoice) => ({
    id: inv.id,
    amount: inv.amount_paid,
    currency: inv.currency,
    status: inv.status,
    created: inv.created,
    description: inv.description ?? inv.lines?.data?.[0]?.description ?? null,
    invoice_pdf: inv.invoice_pdf ?? null,
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
  }))

  const paymentIntentItems = (paymentIntentsResult?.data ?? [])
    .filter((pi: StripePaymentIntent) => pi.status === 'succeeded')
    .map((pi: StripePaymentIntent) => ({
      id: pi.id,
      amount: pi.amount,
      currency: pi.currency,
      status: pi.status,
      created: pi.created,
      description: pi.description ?? null,
      receipt_url: (pi.latest_charge as { receipt_url?: string } | null | string)
        && typeof pi.latest_charge === 'object'
        ? (pi.latest_charge as { receipt_url?: string })?.receipt_url ?? null
        : null,
    }))

  const history = [...invoiceItems, ...paymentIntentItems].sort((a, b) => b.created - a.created)

  return res.json({ history })
})
