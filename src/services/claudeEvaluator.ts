import Anthropic from '@anthropic-ai/sdk';
import type { Offer } from '@prisma/client';
import type { CandidateProfile } from '../types/profile';

const anthropic = new Anthropic();

const TIMEOUT_MS = 300_000;

const SYSTEM_PROMPT = `You are a senior tech recruiter evaluating job offers for you.

Scoring rules — apply all four consistently:
1. SALARY: Compare offer MAX salary to your minimum. If offer max >= your minimum, salary is acceptable — do not penalize it. Only mark salary as a concern if offer max < your minimum. If salary is not disclosed, treat it as neutral and never use it as a reason for recommended=false.
2. CONTRACT TYPE: Your profile lists accepted contract types. Only flag contract type if the offer's type is not in your accepted list. If you accept permanent contracts, do not penalize permanent offers.
3. SENIORITY: Do not penalize offers listed as "mid" level if your skills clearly match the requirements. Only flag seniority if the role explicitly requires fewer years of experience than you have, or uses the word "junior" in the title.
4. FOCUS: Prioritise technical skill overlap, salary acceptability, and work model. These three factors should drive the recommended field.`;

const EVALUATE_OFFERS_TOOL: Anthropic.Tool = {
  name: 'evaluate_offers',
  description: 'Return structured evaluations for each job offer.',
  input_schema: {
    type: 'object',
    properties: {
      evaluations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            offer_index: {
              type: 'integer',
              description: 'Exact index from the offer header (0-based)',
            },
            score: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description:
                "Overall match quality 0-100. CRITICAL scoring rule — skill overlap ratio determines score ceiling: Calculate matched_skills = count of required_skills present in candidate's skills. Calculate overlap_ratio = matched_skills / total required_skills. If overlap_ratio < 0.30 → score MUST be 45 or below. If overlap_ratio < 0.50 → score MUST be 65 or below. If overlap_ratio >= 0.50 → score can be up to 100 based on other factors. This rule overrides all other scoring considerations. Do NOT round up — if ratio is 0.29, cap is 45, not 65.",
            },
            rank: {
              type: 'integer',
              minimum: 1,
              description: 'Overall ranking, 1 = best match',
            },
            matched_reasons: {
              type: 'object',
              description:
                'CRITICAL: No salary. No work model. No generic seniority match. No skills already in missing_skills. Only reference data explicitly present in the offer.',
              properties: {
                pros: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    "List up to 3 genuine advantages for this candidate. Focus on: specific skill matches that differentiate (e.g. GraphQL when it's required), domain/industry fit, leadership or architecture scope, step-up opportunity. Skip: salary, work model, generic seniority match.",
                },
                cons: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'List up to 3 genuine concerns. Focus on: role scope mismatch (fullstack vs frontend target), missing primary skills not already in missing_skills, domain gap (mobile/IoT when targeting web), seniority ambiguity. Skip: salary, work model, skills already in missing_skills array.',
                },
              },
              required: ['pros', 'cons'],
            },
            salary_comparison: {
              type: 'string',
              description: 'One phrase comparing offered salary to the target',
            },
            role_fit: {
              type: 'string',
              description:
                'One sentence on role alignment. CRITICAL: role_fit must be based ONLY on the actual job title and required_skills provided in the offer data. Do NOT mention technologies, frameworks, or role types that are not explicitly listed in the offer. If the offer is for a DBA, say it is a DBA role. If the offer requires Java, do not describe it as a React role.',
            },
            recommended: {
              type: 'boolean',
              description: 'True if candidate should apply',
            },
            offer_language: {
              type: 'string',
              enum: ['pl', 'en'],
              description: 'Detected language of the offer',
            },
          },
          required: [
            'offer_index',
            'score',
            'rank',
            'matched_reasons',
            'salary_comparison',
            'role_fit',
            'recommended',
            'offer_language',
          ],
        },
      },
    },
    required: ['evaluations'],
  },
};

export interface ClaudeEvaluation {
  offer_index: number;
  score: number;
  rank: number;
  matched_reasons: { pros: string[]; cons: string[] };
  salary_comparison: string;
  role_fit: string;
  recommended: boolean;
  offer_language: 'pl' | 'en';
}

export interface EvaluateOffersResult {
  evaluations: ClaudeEvaluation[];
  input_tokens: number;
  output_tokens: number;
  response_ms: number;
  model: string;
}

// Evaluates all pre-filtered offers in a single Claude call.
// Returns null on timeout, JSON parse error, or any Claude API error (RULE A-5).
// Each evaluation carries offer_index so results can be matched back regardless of order.
export async function evaluateOffers(
  profile: CandidateProfile,
  offers: Offer[],
  model: string,
): Promise<EvaluateOffersResult | null> {
  if (offers.length === 0)
    return {
      evaluations: [],
      input_tokens: 0,
      output_tokens: 0,
      response_ms: 0,
      model,
    };

  const result = await _evaluateOffers(profile, offers, model);
  if (result !== null) return result;

  console.error(
    '[claudeEvaluator] Batch returned null — retrying once after 5s',
  );
  await new Promise(resolve => setTimeout(resolve, 5_000));
  return _evaluateOffers(profile, offers, model);
}

async function _evaluateOffers(
  profile: CandidateProfile,
  offers: Offer[],
  model: string,
): Promise<EvaluateOffersResult | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const claudeStart = Date.now();
  let rawResponse: string | undefined;

  try {
    const prompt = buildPrompt(profile, offers);

    const response = await anthropic.messages.create(
      {
        model,
        max_tokens: 16000,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [EVALUATE_OFFERS_TOOL],
        tool_choice: { type: 'tool', name: 'evaluate_offers' },
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: controller.signal },
    );

    const { input_tokens, output_tokens } = response.usage;
    const response_ms = Date.now() - claudeStart;

    const toolUseBlock = response.content.find(b => b.type === 'tool_use') as
      | Anthropic.ToolUseBlock
      | undefined;

    if (!toolUseBlock) {
      console.error(
        '[claudeEvaluator] Batch returned null — no tool_use block in response',
      );
      return null;
    }

    const toolInput = toolUseBlock.input as { evaluations?: unknown };
    rawResponse = JSON.stringify(toolInput).substring(0, 500);

    const parsed = toolInput.evaluations;

    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error('[claudeEvaluator] evaluations is not a non-empty array');
      console.error(
        '[claudeEvaluator] Batch returned null — raw response:',
        rawResponse,
      );
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
        console.error(
          '[claudeEvaluator] Batch returned null — raw response:',
          rawResponse,
        );
        return null;
      }
      results.push(validated);
    }
    return {
      evaluations: results,
      input_tokens,
      output_tokens,
      response_ms,
      model: response.model,
    };
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
    console.error(
      '[claudeEvaluator] Batch returned null — raw response:',
      rawResponse?.substring(0, 500),
    );
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
  const name = `${profile.basic_info.first_name} ${profile.basic_info.last_name}`;
  const techs = Object.values(profile.skills)
    .flat()
    .map(t => t.name)
    .join(', ');
  const salaryPrefs = profile.preferences?.salary ?? [];
  const salaryText =
    salaryPrefs.length > 0
      ? salaryPrefs.map(s => `${s.type} ${s.currency} min ${s.min}`).join(', ')
      : 'not specified';
  const workModel = (profile.preferences?.work_model ?? []).join(', ');
  const targetRoles = (profile.preferences?.target_role ?? []).join(', ');
  const redFlagsText = profile.red_flags
    .map(
      f =>
        `[${f.category}] ${Array.isArray(f.description) ? f.description.join(', ') : f.description}`,
    )
    .join('; ');

  const lines: string[] = [
    '## Your Profile',
    `Name: ${name}`,
    `Technologies: ${techs || 'not specified'}`,
    `Target roles: ${targetRoles || 'not specified'}`,
    `Salary targets: ${salaryText}`,
    `Accepted work models: ${workModel || 'not specified'}`,
    `Dealbreakers by category: ${redFlagsText || 'none'}`,
    '',
    `## ${offers.length} Job Offers to Evaluate`,
    `Rank must span 1-${offers.length} with 1 = best match.`,
    '',
  ];

  for (let i = 0; i < offers.length; i++) {
    // Offer — only essential fields (title, company_name, required_skills, experience_level).
    // Omitting salary, work_model, city and other fields shown separately in UI or handled by pre-filter.
    const offer = offers[i];

    lines.push(`### [${i}] ${offer.title} — ${offer.company_name}`);
    lines.push(
      `Skills required: ${offer.required_skills.join(', ') || 'none listed'}`,
    );
    if (offer.nice_to_have_skills.length > 0) {
      lines.push(`Nice to have: ${offer.nice_to_have_skills.join(', ')}`);
    }
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

  const rawReasons = obj['matched_reasons'];
  const matched_reasons =
    rawReasons && typeof rawReasons === 'object' && !Array.isArray(rawReasons)
      ? {
          pros: Array.isArray((rawReasons as Record<string, unknown>)['pros'])
            ? (
                (rawReasons as Record<string, unknown>)['pros'] as unknown[]
              ).filter((r): r is string => typeof r === 'string')
            : [],
          cons: Array.isArray((rawReasons as Record<string, unknown>)['cons'])
            ? (
                (rawReasons as Record<string, unknown>)['cons'] as unknown[]
              ).filter((r): r is string => typeof r === 'string')
            : [],
        }
      : { pros: [], cons: [] };

  const salary_comparison =
    typeof obj['salary_comparison'] === 'string'
      ? obj['salary_comparison']
      : '';

  const role_fit = typeof obj['role_fit'] === 'string' ? obj['role_fit'] : '';

  const recommended =
    typeof obj['recommended'] === 'boolean' ? obj['recommended'] : false;

  const rawLang = obj['offer_language'];
  const offer_language: 'pl' | 'en' = rawLang === 'pl' ? 'pl' : 'en';

  return {
    offer_index,
    score,
    rank,
    matched_reasons,
    salary_comparison,
    role_fit,
    recommended,
    offer_language,
  };
}
