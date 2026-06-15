import { prisma } from './prisma'

interface Pricing {
  haiku_input: number
  haiku_output: number
  sonnet_input: number
  sonnet_output: number
}

const FALLBACK: Pricing = {
  haiku_input: 1.0,
  haiku_output: 5.0,
  sonnet_input: 3.0,
  sonnet_output: 15.0,
}

async function loadPricing(): Promise<Pricing> {
  try {
    const setting = await prisma.settings.findUnique({ where: { key: 'anthropic_pricing' } })
    if (setting) return { ...FALLBACK, ...(JSON.parse(setting.value) as Partial<Pricing>) }
  } catch { /* use fallback */ }
  return FALLBACK
}

export async function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<number> {
  const p = await loadPricing()
  const isHaiku = model.includes('haiku')
  const inputRate = isHaiku ? p.haiku_input : p.sonnet_input
  const outputRate = isHaiku ? p.haiku_output : p.sonnet_output
  const cost = (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate
  return Math.round(cost * 1_000_000) / 1_000_000
}
