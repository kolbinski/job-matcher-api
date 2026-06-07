import Anthropic from '@anthropic-ai/sdk';
import type { Offer } from '@prisma/client';
import type { CandidateProfile } from '../types/profile';
import { parseEmploymentTypes } from '../lib/offers';

const anthropic = new Anthropic();

const TIMEOUT_MS = 300_000;

const SYSTEM_PROMPT = `You are a senior tech recruiter evaluating job offers for a candidate. Return ONLY a JSON array, no markdown, no preamble.

Scoring rules — apply all four consistently:
1. SALARY: Compare offer MAX salary to candidate minimum. If offer max >= candidate minimum, salary is acceptable — do not penalize it. Only mark salary as a concern if offer max < candidate minimum. If salary is not disclosed, treat it as neutral and never use it as a reason for recommended=false.
2. CONTRACT TYPE: The candidate profile lists accepted contract types. Only flag contract type if the offer's type is not in the candidate's accepted list. If the candidate accepts permanent contracts, do not penalize permanent offers.
3. SENIORITY: Do not penalize offers listed as "mid" level if the candidate's skills clearly match the requirements. Only flag seniority if the role explicitly requires fewer years of experience than the candidate has, or uses the word "junior" in the title.
4. FOCUS: Prioritise technical skill overlap, salary acceptability, and work model. These three factors should drive the recommended field.`;

export interface ClaudeEvaluation {
  offer_index: number;
  score: number;
  rank: number;
  matched_reasons: string[];
  missing_skills: string[];
  salary_comparison: string;
  role_fit: string;
  recommended: boolean;
}

// Evaluates all pre-filtered offers in a single Claude call.
// Returns null on timeout, JSON parse error, or any Claude API error (RULE A-5).
// Each evaluation carries offer_index so results can be matched back regardless of order.
export async function evaluateOffers(
  profile: CandidateProfile,
  offers: Offer[],
): Promise<ClaudeEvaluation[] | null> {
  if (offers.length === 0) return [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const claudeStart = Date.now();

  try {
    const prompt = buildPrompt(profile, offers);

    const response = await anthropic.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
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
            content: prompt,
          },
        ],
      },
      { signal: controller.signal },
    );

    console.log(
      `[claudeEvaluator] Response received in ${Date.now() - claudeStart}ms`,
    );

    const block = response.content[0];
    if (block?.type !== 'text') return null;

    const rawResponse = block.text;

    const cleaned = stripCodeFences(rawResponse);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error(
        '[claudeEvaluator] JSON parse error. Raw response:',
        rawResponse,
      );
      return null;
    }

    console.log(
      '[claudeEvaluator] Parsed evaluations:',
      Array.isArray(parsed) ? parsed.length : 'parse failed',
    );

    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error('[claudeEvaluator] Response is not a non-empty array');
      return null;
    }

    if (parsed.length !== offers.length) {
      console.warn(
        '[claudeEvaluator] Length mismatch: expected',
        offers.length,
        'got',
        parsed.length,
        '— using what was returned',
      );
    }

    const results: ClaudeEvaluation[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const validated = validateEvaluation(parsed[i], i + 1);
      if (!validated) {
        console.error('[claudeEvaluator] Invalid item at index', i);
        return null;
      }
      results.push(validated);
    }
    return results;
  } catch (err) {
    console.error(
      '[claudeEvaluator] Offers sent:',
      offers.length,
      '| Timeout:',
      TIMEOUT_MS,
      'ms | Elapsed:',
      Date.now() - claudeStart,
      'ms | ~tokens estimated:',
      offers.length * 150,
    );
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        console.error(
          `[claudeEvaluator] TIMEOUT: request aborted after ${TIMEOUT_MS}ms`,
        );
      } else {
        console.error('[claudeEvaluator] API ERROR:', err.message, err.name);
      }
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Exported for unit testing.
export function stripCodeFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function buildPrompt(profile: CandidateProfile, offers: Offer[]): string {
  // Profile — only essential fields sent to Claude (no employment_history, education, personal_projects)
  const name = profile.basic_info.full_name;
  const techs = Object.values(profile.technologies).flat().map(t => t.name).join(', ');
  const salaryPref = profile.preferences?.salary?.find(
    s => s.type === 'b2b' && s.currency.toUpperCase() === 'PLN',
  );
  const salaryMin =
    salaryPref?.min ??
    profile.career_goals?.short_term?.salary_target_pln_net_b2b?.min ??
    null;
  const workModel = (profile.preferences?.work_model ?? []).join(', ');
  const targetRoles = (
    profile.career_goals?.short_term?.target_role ?? []
  ).join(', ');
  const redFlags = profile.red_flags.map(f => f.description).join(', ');

  const lines: string[] = [
    '## Candidate Profile',
    `Name: ${name}`,
    `Technologies: ${techs || 'not specified'}`,
    `Target roles: ${targetRoles || 'not specified'}`,
    `Salary target (PLN net B2B, minimum): ${salaryMin ?? 'not specified'}`,
    `Accepted work models: ${workModel || 'not specified'}`,
    `Dealbreakers (auto-rejected if matched): ${redFlags || 'none'}`,
    '',
    `## ${offers.length} Job Offers to Evaluate`,
    '',
    'Evaluate each offer and return a JSON array with one object per offer.',
    'Each object must have:',
    '  offer_index (integer): the exact index shown in the offer header, e.g. 0, 1, 2…',
    '  score (integer 0-100): overall match quality',
    `  rank (integer 1-${offers.length}): overall ranking, 1 = best match`,
    '  matched_reasons (string[]): 1-3 specific reasons this offer fits the candidate',
    '  missing_skills (string[]): skills in job requirements the candidate likely lacks',
    '  salary_comparison (string): one phrase comparing offered salary to the target',
    '  role_fit (string): one sentence on role alignment',
    '  recommended (boolean): true if candidate should apply',
    '',
  ];

  for (let i = 0; i < offers.length; i++) {
    // Offer — only essential fields (slug, title, company_name, required_skills,
    // employment_types, workplace_type, experience_level). Omitting city, street,
    // latitude, longitude, multilocation, nice_to_have_skills, etc.
    const offer = offers[i];
    const types = parseEmploymentTypes(offer);
    const salaryStr =
      types
        .filter(t => t.from !== undefined || t.to !== undefined)
        .map(
          t =>
            `${t.type ?? 'unknown'}: ${t.from ?? '?'}-${t.to ?? '?'} ${t.currency ?? 'PLN'}`,
        )
        .join(', ') || 'not specified';

    lines.push(`### [${i}] ${offer.title} — ${offer.company_name}`);
    lines.push(
      `Skills required: ${offer.required_skills.join(', ') || 'none listed'}`,
    );
    lines.push(`Salary: ${salaryStr}`);
    lines.push(`Work type: ${offer.workplace_type ?? 'not specified'}`);
    lines.push(`Level: ${offer.experience_level ?? 'not specified'}`);
    lines.push('');
  }

  return lines.join('\n');
}

function validateEvaluation(
  item: unknown,
  defaultRank: number,
): ClaudeEvaluation | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;

  const rawIndex = obj['offer_index'];
  if (typeof rawIndex !== 'number') return null;
  const offer_index = Math.round(rawIndex);

  const rawScore = obj['score'];
  if (typeof rawScore !== 'number') return null;
  const score = Math.min(100, Math.max(0, Math.round(rawScore)));

  const rawRank = obj['rank'];
  const rank =
    typeof rawRank === 'number' && rawRank >= 1
      ? Math.round(rawRank)
      : defaultRank;

  const matched_reasons = Array.isArray(obj['matched_reasons'])
    ? (obj['matched_reasons'] as unknown[]).filter(
        (r): r is string => typeof r === 'string',
      )
    : [];

  const missing_skills = Array.isArray(obj['missing_skills'])
    ? (obj['missing_skills'] as unknown[]).filter(
        (s): s is string => typeof s === 'string',
      )
    : [];

  const salary_comparison =
    typeof obj['salary_comparison'] === 'string'
      ? obj['salary_comparison']
      : '';

  const role_fit = typeof obj['role_fit'] === 'string' ? obj['role_fit'] : '';

  const recommended =
    typeof obj['recommended'] === 'boolean' ? obj['recommended'] : false;

  return {
    offer_index,
    score,
    rank,
    matched_reasons,
    missing_skills,
    salary_comparison,
    role_fit,
    recommended,
  };
}
