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

  // Only consider users who don't yet have a stripe_customer_id
  const users = await prisma.user.findMany({
    where: { stripe_customer_id: null },
    select: { id: true, email: true },
  })

  if (users.length === 0) {
    console.log('No users to backfill — all users already have stripe_customer_id')
    return
  }

  console.log(`Found ${users.length} users without stripe_customer_id`)

  // Build email → stripe customer_id map by paginating all Stripe customers
  const emailToCustomerId = new Map<string, string>()
  let page = await stripe.customers.list({ limit: 100 })
  while (true) {
    for (const customer of page.data) {
      if (customer.email) {
        emailToCustomerId.set(customer.email.toLowerCase(), customer.id)
      }
    }
    if (!page.has_more) break
    page = await stripe.customers.list({ limit: 100, starting_after: page.data[page.data.length - 1]!.id })
  }

  console.log(`Fetched ${emailToCustomerId.size} Stripe customers`)

  let updated = 0
  let skipped = 0

  for (const user of users) {
    const customerId = emailToCustomerId.get(user.email.toLowerCase())
    if (!customerId) {
      skipped++
      continue
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { stripe_customer_id: customerId },
    })

    updated++
    console.log(`Updated user ${user.id} (${user.email}) → ${customerId}`)
  }

  console.log(`Done. Updated ${updated}, skipped ${skipped} (no Stripe customer found).`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
