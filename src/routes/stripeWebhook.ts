import { Router } from 'express'
import type { Request, Response } from 'express'
import Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { env } from '../lib/env'

export const stripeWebhookRouter = Router()

let _stripe: InstanceType<typeof Stripe> | null = null
function getStripe(): InstanceType<typeof Stripe> {
  if (!_stripe) _stripe = new Stripe(env.STRIPE_SECRET_KEY)
  return _stripe
}

stripeWebhookRouter.post('/', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature']
  if (!sig) {
    return res.status(400).json({ error: 'Missing stripe-signature header' })
  }

  try {
    const stripe = getStripe()
    const event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
    )

    if (event.type === 'checkout.session.completed') {
      const obj = event.data.object as {
        client_reference_id: string | null
        subscription: string | null
      }
      const userId = obj.client_reference_id
      const stripeSubscriptionId = obj.subscription

      console.log('[stripe-webhook] checkout.session.completed fields:', { client_reference_id: userId, subscription: stripeSubscriptionId })

      if (!userId || !stripeSubscriptionId) {
        console.error('[stripe-webhook] Missing userId or stripeSubscriptionId in checkout.session.completed')
        return res.json({ received: true })
      }

      const stripeSub = await getStripe().subscriptions.retrieve(stripeSubscriptionId)
      console.log('[stripe-webhook] raw stripeSub:', JSON.stringify({
        id: stripeSub.id,
        current_period_start: (stripeSub as any).current_period_start,
        current_period_end: (stripeSub as any).current_period_end,
        status: (stripeSub as any).status,
      }))
      console.log('[stripe-webhook] stripeSub keys:', Object.keys(stripeSub))
      console.log('[stripe-webhook] stripeSub.current_period_start:', (stripeSub as any).current_period_start)
      console.log('[stripe-webhook] stripeSub.current_period_end:', (stripeSub as any).current_period_end)
      const currentPeriodStart = new Date((stripeSub.items.data[0] as any).current_period_start * 1000)
      const currentPeriodEnd = new Date((stripeSub.items.data[0] as any).current_period_end * 1000)

      const proPlan = await prisma.plan.findUnique({ where: { name: 'pro' } })
      if (!proPlan) {
        console.error('[stripe-webhook] Pro plan not found in DB')
        return res.json({ received: true })
      }

      const upsertResult = await prisma.subscription.upsert({
        where: { user_id: userId },
        update: {
          plan_id: proPlan.id,
          stripe_subscription_id: stripeSubscriptionId,
          status: 'active',
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
        },
        create: {
          user_id: userId,
          plan_id: proPlan.id,
          stripe_subscription_id: stripeSubscriptionId,
          status: 'active',
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
        },
      })

      await prisma.user.update({
        where: { id: userId },
        data: { free_plan_snapshot: null },
      })

      console.log(`[stripe-webhook] Upgraded user ${userId} to Pro plan`)
      console.log('[stripe-webhook] upsert result:', JSON.stringify(upsertResult))
    }

    if (event.type === 'customer.subscription.deleted') {
      const obj = event.data.object as { id: string }

      const sub = await prisma.subscription.findFirst({
        where: { stripe_subscription_id: obj.id },
      })
      if (!sub) {
        console.error(`[stripe-webhook] No subscription found for stripe_subscription_id: ${obj.id}`)
        return res.json({ received: true })
      }

      const freePlan = await prisma.plan.findUnique({ where: { name: 'free' } })
      if (!freePlan) {
        console.error('[stripe-webhook] Free plan not found in DB')
        return res.json({ received: true })
      }

      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          plan_id: freePlan.id,
          stripe_subscription_id: null,
          status: 'cancelled',
          current_period_start: null,
          current_period_end: null,
        },
      })

      console.log(`[stripe-webhook] Downgraded user ${sub.user_id} to Free plan`)
    }

    return res.json({ received: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Signature errors are 400; handler errors are 500
    const isSignatureError = message.includes('No signatures found') || message.includes('signature')
    if (isSignatureError) {
      console.error('[stripe-webhook] Signature verification failed:', message)
      return res.status(400).json({ error: `Webhook error: ${message}` })
    }
    console.error('[stripe-webhook] Handler error:', message)
    return res.status(500).json({ error: 'Internal webhook handler error' })
  }
})
