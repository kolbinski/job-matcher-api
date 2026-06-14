import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import Stripe from 'stripe'

const prisma = new PrismaClient()

async function main() {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    console.error('STRIPE_SECRET_KEY not set')
    process.exit(1)
  }
  const stripe = new Stripe(stripeKey)

  const subscriptions = await prisma.subscription.findMany({
    where: {
      stripe_subscription_id: { not: null },
      user: { stripe_customer_id: null },
    },
    select: { user_id: true, stripe_subscription_id: true },
  })

  if (subscriptions.length === 0) {
    console.log('No users to backfill — all paid users already have stripe_customer_id')
    return
  }

  console.log(`Found ${subscriptions.length} subscriptions to backfill`)

  let updated = 0
  for (const sub of subscriptions) {
    try {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id!)
      const customerId = typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id
      await prisma.user.update({
        where: { id: sub.user_id },
        data: { stripe_customer_id: customerId },
      })
      updated++
      console.log(`Updated user ${sub.user_id} → stripe_customer_id: ${customerId}`)
    } catch (err) {
      console.error(`Failed for user ${sub.user_id} / sub ${sub.stripe_subscription_id}:`, err)
    }
  }

  console.log(`Done. Updated ${updated} / ${subscriptions.length} users`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
