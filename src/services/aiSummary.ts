import Anthropic from '@anthropic-ai/sdk'
import type { Offer } from '@prisma/client'

const anthropic = new Anthropic()

// Stable system prompt — cache_control marker ready for when it grows past
// Sonnet's 2048-token minimum (currently ~200 tokens, below the threshold)
const SYSTEM_PROMPT =
  'You are a career advisor AI. Analyze job match data and respond with ONLY a valid JSON object — no markdown, no explanation.\n' +
  'Format: {"ai_summary": "<2-3 sentences on match quality>", "ai_recommendation": "<apply|consider|skip>"}\n' +
  'Guidelines: apply if score ≥ 70 and no critical skill gaps; consider if score 40-69 or gaps are learnable; skip otherwise.'

export interface AiSummaryResult {
  aiSummary: string
  aiRecommendation: 'apply' | 'consider' | 'skip'
}

// Returns null on timeout or any Claude API error — the route handler sets
// ai_scoring: false in meta and rolls back the billing transaction (RULE A-2).
export async function generateAiSummary(
  offer: Offer,
  score: number,
  matchReasons: string[],
  missingSkills: string[]
): Promise<AiSummaryResult | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await anthropic.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content:
              `Job: ${offer.title} at ${offer.company_name}\n` +
              `Score: ${score}/100\n` +
              `Match reasons: ${matchReasons.length > 0 ? matchReasons.join('; ') : 'none'}\n` +
              `Missing skills: ${missingSkills.length > 0 ? missingSkills.join(', ') : 'none'}\n\n` +
              'Provide your JSON analysis.',
          },
        ],
      },
      { signal: controller.signal }
    )

    clearTimeout(timeoutId)

    const block = response.content[0]
    if (block?.type !== 'text') return null

    const parsed = JSON.parse(block.text) as Record<string, unknown>
    const recommendation = parsed['ai_recommendation']
    if (!['apply', 'consider', 'skip'].includes(recommendation as string)) return null

    return {
      aiSummary: String(parsed['ai_summary'] ?? ''),
      aiRecommendation: recommendation as 'apply' | 'consider' | 'skip',
    }
  } catch {
    clearTimeout(timeoutId)
    return null
  }
}
