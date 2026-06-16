import { Router } from 'express'
import type { Request, Response } from 'express'
import Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { env } from '../lib/env'
import { buildAndSaveFreePlanSnapshot } from '../services/syncService'
import { type SalaryPref } from '../services/syncReport'

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
      console.log('[stripe-webhook] session metadata:', JSON.stringify(event.data.object.metadata))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.log('[stripe-webhook] client_reference_id:', (event.data.object as any).client_reference_id)

      const obj = event.data.object as {
        client_reference_id: string | null
        subscription: string | null
        metadata: Record<string, string> | null
        customer?: string | null
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.log('[stripe-webhook] customer field raw:', (event.data.object as any).customer)
      const stripeCustomerId = obj.customer ?? null
      const sessionType = obj.metadata?.['type'] ?? null

      if (sessionType === 'scan_package' || sessionType === 'cv_package' || sessionType === 'cl_package' || sessionType === 'profile_rematch_package' || sessionType === 'review_package') {
        const userId = obj.metadata?.['user_id']
        const amount = Number(obj.metadata?.['amount'] ?? '0')
        if (!userId) {
          console.error(`[stripe-webhook] ${sessionType}: missing user_id in metadata`)
          return res.json({ received: true })
        }

        if (sessionType === 'profile_rematch_package') {
          await prisma.user.update({
            where: { id: userId },
            data: {
              profile_relevant_change_counter_max: { increment: amount + 1 },
              profile_relevant_change_pending: false,
            },
          })
          console.log(`[stripe-webhook] profile_rematch_package: incremented profile_relevant_change_counter_max by ${amount} for user ${userId}`)
        } else if (sessionType === 'review_package') {
          await prisma.user.update({
            where: { id: userId },
            data: { review_by_ai_counter_max: { increment: amount } },
          })
          console.log(`[stripe-webhook] review_package: incremented review_by_ai_counter_max by ${amount} for user ${userId}`)
        } else {
          const counterField =
            sessionType === 'cv_package' ? 'cv_counter_max' :
            sessionType === 'cl_package' ? 'cl_counter_max' :
            'scan_page_counter_max'

          await prisma.user.update({
            where: { id: userId },
            data: { [counterField]: { increment: amount } },
          })
          console.log(`[stripe-webhook] ${sessionType}: incremented ${counterField} by ${amount} for user ${userId}`)
        }

        // customer field is null on mode='payment' events — retrieve session to expand it
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessionId = (event.data.object as any).id as string
        const fullSession = await getStripe().checkout.sessions.retrieve(sessionId, { expand: ['customer'] })
        const packageCustomerId = typeof fullSession.customer === 'string'
          ? fullSession.customer
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : (fullSession.customer as any)?.id ?? null
        console.log(`[stripe-webhook] ${sessionType}: retrieved customer from session: ${packageCustomerId}`)

        if (packageCustomerId) {
          await prisma.user.update({
            where: { id: userId },
            data: { stripe_customer_id: packageCustomerId },
          })
          console.log(`[stripe-webhook] saved stripe_customer_id: ${packageCustomerId} for user: ${userId}`)
        }

        return res.json({ received: true })
      }

      // Pro subscription checkout
      const userId = obj.client_reference_id
      const stripeSubscriptionId = obj.subscription

      console.log('[stripe-webhook] checkout.session.completed fields:', { client_reference_id: userId, subscription: stripeSubscriptionId })

      if (!userId || !stripeSubscriptionId) {
        console.error('[stripe-webhook] Missing userId or stripeSubscriptionId in checkout.session.completed')
        return res.json({ received: true })
      }

      const stripeSub = await getStripe().subscriptions.retrieve(stripeSubscriptionId)
      const item0 = stripeSub.items.data[0] as unknown as { current_period_start: number; current_period_end: number }
      const currentPeriodStart = new Date(item0.current_period_start * 1000)
      const currentPeriodEnd = new Date(item0.current_period_end * 1000)

      const [proPlan, freePlan] = await Promise.all([
        prisma.plan.findUnique({ where: { name: 'pro' } }),
        prisma.plan.findUnique({ where: { name: 'free' } }),
      ])
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

      const proLimits = proPlan.limits as { max_scan_page?: number; max_cv?: number; max_cl?: number; max_review_by_ai?: number }
      const freeLimits = (freePlan?.limits ?? {}) as { max_scan_page?: number; max_cv?: number; max_cl?: number; max_review_by_ai?: number }

      await prisma.user.update({
        where: { id: userId },
        data: {
          free_plan_snapshot: Prisma.JsonNull,
          scan_page_counter_max: { increment: (proLimits.max_scan_page ?? 0) - (freeLimits.max_scan_page ?? 0) },
          cv_counter_max: { increment: (proLimits.max_cv ?? 0) - (freeLimits.max_cv ?? 0) },
          cl_counter_max: { increment: (proLimits.max_cl ?? 0) - (freeLimits.max_cl ?? 0) },
          review_by_ai_counter_max: { increment: (proLimits.max_review_by_ai ?? 0) - (freeLimits.max_review_by_ai ?? 0) },
        },
      })

      if (stripeCustomerId) {
        await prisma.user.update({
          where: { id: userId },
          data: { stripe_customer_id: stripeCustomerId },
        })
      }

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

      const userId = sub.user_id
      const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { profile: true } })
      if (userRow?.profile != null) {
        const rawProfile = userRow.profile as unknown as {
          preferences?: { salary?: Array<{ type?: string; currency?: string; min?: number }> }
        }
        const salaryPrefs: SalaryPref[] = (rawProfile.preferences?.salary ?? []).filter(
          (p): p is SalaryPref => p.type != null && p.currency != null && p.min != null,
        )
        let exchangeRates: Record<string, number> = {}
        try {
          const ratesSetting = await prisma.settings.findUnique({ where: { key: 'exchange_rates' } })
          if (ratesSetting) exchangeRates = JSON.parse(ratesSetting.value) as Record<string, number>
        } catch { /* rates stay empty */ }
        await buildAndSaveFreePlanSnapshot(userId, salaryPrefs, exchangeRates, userRow.profile)
      }
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
