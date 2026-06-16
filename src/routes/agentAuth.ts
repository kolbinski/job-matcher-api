import { Router } from 'express'
import { z } from 'zod'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { prisma } from '../lib/prisma'
import { env } from '../lib/env'
import { AppError } from '../lib/errors'

export const agentAuthRouter = Router()

// USD-based fallback rates: how many units of each currency per 1 USD
const FALLBACK_RATES: Record<string, number> = { USD: 1, PLN: 3.90, EUR: 0.92, GBP: 0.79, CHF: 0.90, CZK: 23.5, UAH: 41.5, DKK: 6.88, SEK: 10.5, NOK: 10.6 }

async function refreshExchangeRates(): Promise<void> {
  const updatedAt = await prisma.settings.findUnique({ where: { key: 'exchange_rates_updated_at' } })
  const stale =
    !updatedAt ||
    Date.now() - new Date(updatedAt.value).getTime() > 24 * 60 * 60 * 1000

  if (!stale) return

  // Read currencies list from general_settings
  const generalSetting = await prisma.settings.findUnique({ where: { key: 'general_settings' } })
  let currencies: string[] = Object.keys(FALLBACK_RATES)
  try {
    if (generalSetting) {
      const gs = JSON.parse(generalSetting.value) as { currencies?: string[] }
      if (Array.isArray(gs.currencies) && gs.currencies.length > 0) {
        currencies = gs.currencies.map(c => c.toUpperCase())
      }
    }
  } catch {
    console.warn('[agentAuth] failed to parse general_settings currencies, using fallback list')
  }

  // Start with USD = 1 as base, fill remaining from fallbacks
  const rates: Record<string, number> = { USD: 1 }
  for (const cur of currencies) {
    if (cur !== 'USD') rates[cur] = FALLBACK_RATES[cur] ?? 1
  }

  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD')
    if (resp.ok) {
      const data = (await resp.json()) as { result: string; rates: Record<string, number> }
      if (data.result === 'success') {
        for (const cur of currencies) {
          const apiRate = data.rates[cur]
          if (apiRate && apiRate > 0) {
            rates[cur] = Math.round(apiRate * 10000) / 10000
          }
        }
        rates['USD'] = 1
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
