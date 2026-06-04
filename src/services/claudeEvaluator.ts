import Anthropic from '@anthropic-ai/sdk'
import type { Offer } from '@prisma/client'
import type { CandidateProfile } from '../types/profile'
import { parseEmploymentTypes } from '../lib/offers'

const anthropic = new Anthropic()

const SYSTEM_PROMPT =
  'You are a senior tech recruiter evaluating job offers for a candidate. Return ONLY a JSON array, no markdown, no preamble.'

export interface ClaudeEvaluation {
  score: number
  rank: number
  matched_reasons: string[]
  missing_skills: string[]
  salary_comparison: string
  role_fit: string
  recommended: boolean
}

// Evaluates up to 30 pre-filtered offers in a single Claude call.
// Returns null on timeout, JSON parse error, or any Claude API error (RULE A-5).
// The returned array is indexed to match the input offers array order.
export async function evaluateOffers(
  profile: CandidateProfile,
  offers: Offer[]
): Promise<ClaudeEvaluation[] | null> {
  if (offers.length === 0) return []

  const controller = new AbortController()
  // 30s timeout — batch of 30 offers requires more generation time than single-offer aiSummary (10s)
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  try {
    const response = await anthropic.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
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
            content: buildPrompt(profile, offers),
          },
        ],
      },
      { signal: controller.signal }
    )

    const block = response.content[0]
    if (block?.type !== 'text') return null

    let parsed: unknown
    try {
      parsed = JSON.parse(block.text)
    } catch {
      console.error('[claudeEvaluator] JSON parse error')
      return null
    }

    if (!Array.isArray(parsed) || parsed.length !== offers.length) {
      console.error(
        '[claudeEvaluator] Response array length mismatch: expected',
        offers.length,
        'got',
        Array.isArray(parsed) ? parsed.length : 'non-array'
      )
      return null
    }

    const results: ClaudeEvaluation[] = []
    for (let i = 0; i < parsed.length; i++) {
      const validated = validateEvaluation(parsed[i], i + 1)
      if (!validated) {
        console.error('[claudeEvaluator] Invalid item at index', i)
        return null
      }
      results.push(validated)
    }
    return results
  } catch (err) {
    if (err instanceof Error && err.name !== 'AbortError') {
      console.error('[claudeEvaluator] Claude API error:', err.message)
    }
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

function buildPrompt(profile: CandidateProfile, offers: Offer[]): string {
  const techs = profile.technologies.map((t) => t.name).join(', ')
  const salaryMin =
    profile.preferences?.salary_pln_net_b2b?.min ??
    profile.career_goals?.short_term?.salary_target_pln_net_b2b?.min ??
    null
  const remote =
    profile.basic_info.remote_ok ||
    profile.preferences?.work_model?.toLowerCase() === 'remote'

  const lines: string[] = [
    '## Candidate Profile',
    `Technologies: ${techs || 'not specified'}`,
    `Salary target (PLN net B2B, minimum): ${salaryMin ?? 'not specified'}`,
    `Remote required: ${remote ? 'yes' : 'no'}`,
    '',
    `## ${offers.length} Job Offers to Evaluate`,
    '',
    'Evaluate each offer and return a JSON array with one object per offer, in the same order.',
    'Each object must have:',
    '  score (integer 0-100): overall match quality',
    `  rank (integer 1-${offers.length}): overall ranking, 1 = best match`,
    '  matched_reasons (string[]): 1-3 specific reasons this offer fits the candidate',
    '  missing_skills (string[]): skills in job requirements the candidate likely lacks',
    '  salary_comparison (string): one phrase comparing offered salary to the target',
    '  role_fit (string): one sentence on role alignment',
    '  recommended (boolean): true if candidate should apply',
    '',
  ]

  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i]
    const types = parseEmploymentTypes(offer)
    const salaryStr =
      types
        .filter((t) => t.from !== undefined || t.to !== undefined)
        .map(
          (t) =>
            `${t.type ?? 'unknown'}: ${t.from ?? '?'}-${t.to ?? '?'} ${t.currency ?? 'PLN'}`
        )
        .join(', ') || 'not specified'

    lines.push(`### [${i}] ${offer.title} — ${offer.company_name}`)
    lines.push(`Skills required: ${offer.required_skills.join(', ') || 'none listed'}`)
    lines.push(`Salary: ${salaryStr}`)
    lines.push(`Work type: ${offer.workplace_type ?? 'not specified'}`)
    lines.push(`Level: ${offer.experience_level ?? 'not specified'}`)
    lines.push('')
  }

  return lines.join('\n')
}

function validateEvaluation(item: unknown, defaultRank: number): ClaudeEvaluation | null {
  if (!item || typeof item !== 'object') return null
  const obj = item as Record<string, unknown>

  const rawScore = obj['score']
  if (typeof rawScore !== 'number') return null
  const score = Math.min(100, Math.max(0, Math.round(rawScore)))

  const rawRank = obj['rank']
  const rank =
    typeof rawRank === 'number' && rawRank >= 1 ? Math.round(rawRank) : defaultRank

  const matched_reasons = Array.isArray(obj['matched_reasons'])
    ? (obj['matched_reasons'] as unknown[]).filter((r): r is string => typeof r === 'string')
    : []

  const missing_skills = Array.isArray(obj['missing_skills'])
    ? (obj['missing_skills'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : []

  const salary_comparison =
    typeof obj['salary_comparison'] === 'string' ? obj['salary_comparison'] : ''

  const role_fit = typeof obj['role_fit'] === 'string' ? obj['role_fit'] : ''

  const recommended =
    typeof obj['recommended'] === 'boolean' ? obj['recommended'] : false

  return {
    score,
    rank,
    matched_reasons,
    missing_skills,
    salary_comparison,
    role_fit,
    recommended,
  }
}
