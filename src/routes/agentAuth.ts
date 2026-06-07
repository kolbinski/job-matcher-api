import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { prisma } from '../lib/prisma'
import { env } from '../lib/env'
import { AppError } from '../lib/errors'

export const agentAuthRouter = Router()

const FALLBACK_RATES: Record<string, number> = { USD: 3.85, EUR: 4.25, GBP: 5.10, CHF: 4.40 }

async function refreshExchangeRates(): Promise<void> {
  const updatedAt = await prisma.settings.findUnique({ where: { key: 'exchange_rates_updated_at' } })
  const stale =
    !updatedAt ||
    Date.now() - new Date(updatedAt.value).getTime() > 24 * 60 * 60 * 1000

  if (!stale) return

  const rates: Record<string, number> = { ...FALLBACK_RATES }
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/PLN')
    if (resp.ok) {
      const data = (await resp.json()) as { result: string; rates: Record<string, number> }
      if (data.result === 'success') {
        for (const [cur, fallback] of Object.entries(FALLBACK_RATES)) {
          const apiRate = data.rates[cur]
          rates[cur] = apiRate && apiRate > 0 ? Math.round((1 / apiRate) * 10000) / 10000 : fallback
        }
      }
    }
  } catch (err) {
    console.warn('[agentAuth] exchange rate fetch failed, using fallback:', err)
  }

  const now = new Date().toISOString()
  await prisma.settings.upsert({
    where: { key: 'exchange_rates' },
    update: { value: JSON.stringify(rates) },
    create: { key: 'exchange_rates', value: JSON.stringify(rates) },
  })
  await prisma.settings.upsert({
    where: { key: 'exchange_rates_updated_at' },
    update: { value: now },
    create: { key: 'exchange_rates_updated_at', value: now },
  })
  console.log('[agentAuth] exchange rates saved:', rates)
}

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

agentAuthRouter.post('/login', async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: 'Invalid request body' })
  }

  const { email, password } = parsed.data

  const agent = await prisma.agent.findUnique({ where: { email } })
  if (!agent) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')
  }

  const valid = await bcrypt.compare(password, agent.password_hash)
  if (!valid) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')
  }

  const token = jwt.sign({ agentId: agent.id, email: agent.email }, env.JWT_SECRET, { expiresIn: '30d' })

  // Refresh exchange rates in background — must not block or fail login
  refreshExchangeRates().catch(err => console.error('[agentAuth] exchange rate refresh error:', err))

  res.json({ token })
})
