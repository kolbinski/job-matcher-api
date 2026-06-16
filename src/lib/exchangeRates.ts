import { prisma } from './prisma'

const FALLBACK_RATES: Record<string, number> = {
  USD: 1, PLN: 3.90, EUR: 0.92, GBP: 0.79, CHF: 0.90,
  CZK: 23.5, UAH: 41.5, DKK: 6.88, SEK: 10.5, NOK: 10.6,
}

export async function updateExchangeRates(): Promise<void> {
  const updatedAt = await prisma.settings.findUnique({ where: { key: 'exchange_rates_updated_at' } })
  const stale =
    !updatedAt ||
    Date.now() - new Date(updatedAt.value).getTime() > 24 * 60 * 60 * 1000

  if (!stale) return

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
    console.warn('[exchangeRates] failed to parse general_settings currencies, using fallback list')
  }

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
    console.warn('[exchangeRates] rate fetch failed, using fallback values:', err)
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
  console.log('[exchangeRates] saved:', rates)
}
