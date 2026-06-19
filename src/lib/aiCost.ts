import { prisma } from './prisma'

type ModelPricing = { input: number; output: number }
type PricingTable = Record<string, ModelPricing>

const FALLBACK: PricingTable = {
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
}

async function loadPricing(): Promise<PricingTable> {
  try {
    const setting = await prisma.settings.findUnique({ where: { key: 'anthropic_pricing' } })
    if (setting) return { ...FALLBACK, ...(JSON.parse(setting.value) as PricingTable) }
  } catch { /* use fallback */ }
  return FALLBACK
}

export async function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<number> {
  const pricing = await loadPricing()
  const p = pricing[model]
  const inputRate = p?.input ?? 0
  const outputRate = p?.output ?? 0
  const cost = (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate
  return Math.round(cost * 1_000_000) / 1_000_000
}
