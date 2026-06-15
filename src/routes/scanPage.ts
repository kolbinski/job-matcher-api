import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import slugify from 'slugify';
import type { Offer } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { validateJwt } from '../middleware/validateJwt';
import { getClaudeModel } from '../lib/claudeModels';
import { CandidateProfileSchema } from '../types/profile';
import { evaluateOffers } from '../services/claudeEvaluator';
import { AppError } from '../lib/errors';
import { type SalaryPref } from '../services/syncReport';
import { calculateCost } from '../lib/aiCost';

export const scanPageRouter = Router();

const anthropic = new Anthropic();

const BodySchema = z.object({
  page_text: z.string().min(1),
  page_url: z.string().url().optional(),
});

const PARSE_SYSTEM_PROMPT =
  'You are a job offer parser. Extract structured data from the provided page text. If the page is not a job offer, set is_job_offer to false and all other fields to null/empty.';

const PARSE_TOOL: Anthropic.Tool = {
  name: 'parse_job_offer',
  description: 'Extract structured job offer data from the page text.',
  input_schema: {
    type: 'object',
    properties: {
      is_job_offer: { type: 'boolean' },
      title: { type: ['string', 'null'] },
      company: { type: ['string', 'null'] },
      url: { type: ['string', 'null'] },
      salary: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { type: 'string' },
              currency: { type: 'string' },
              from: { type: ['number', 'null'] },
              to: { type: ['number', 'null'] },
              unit: {
                type: ['string', 'null'],
                description: "Pay period unit, e.g. 'Month', 'Hour', 'Day'",
              },
            },
            required: ['type', 'currency'],
          },
          { type: 'null' },
        ],
      },
      required_skills: { type: 'array', items: { type: 'string' } },
      nice_to_have_skills: { type: 'array', items: { type: 'string' } },
      workplace_type: {
        type: ['string', 'null'],
        enum: ['remote', 'hybrid', 'office', null],
      },
      city: { type: ['string', 'null'] },
      employment_type: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
    },
    required: ['is_job_offer'],
  },
};

interface ParsedOffer {
  is_job_offer: boolean;
  title: string | null;
  company: string | null;
  url: string | null;
  salary: {
    type: string;
    currency: string;
    from: number | null;
    to: number | null;
    unit: string | null;
  } | null;
  required_skills: string[];
  nice_to_have_skills: string[];
  workplace_type: 'remote' | 'hybrid' | 'office' | null;
  city: string | null;
  employment_type: string | null;
  description: string | null;
}

function buildSalaryEntries(
  employmentTypes: unknown,
  salaryPrefs: SalaryPref[],
  rates: Record<string, number>,
): Array<{
  min: number;
  max: number;
  currency: string;
  type: string;
  delta: number;
  delta_normalized: number;
}> {
  if (salaryPrefs.length === 0) return [];
  const types = Array.isArray(employmentTypes)
    ? (employmentTypes as Array<{
        from?: number;
        to?: number;
        currency?: string;
        type?: string;
        unit?: string;
      }>)
    : [];
  const entries: ReturnType<typeof buildSalaryEntries> = [];
  for (const et of types) {
    const { from, to, currency, type: etType, unit } = et;
    if (from == null || to == null || !currency || !etType) continue;
    const pref = salaryPrefs.find(
      p =>
        p.type.toLowerCase() === etType.toLowerCase() &&
        p.currency.toUpperCase() === currency.toUpperCase(),
    );
    if (!pref) continue;
    const effectiveTo = unit?.toLowerCase() === 'day' ? to * 20 : to;
    const delta = effectiveTo - pref.min;
    const rate =
      currency.toUpperCase() === 'PLN'
        ? 1
        : (rates[currency.toUpperCase()] ?? 1);
    entries.push({
      min: from,
      max: to,
      currency,
      type: etType,
      delta,
      delta_normalized: Math.round(delta * rate),
    });
  }
  return entries;
}

function mapUserOfferResponse(
  userOffer: {
    id: string;
    claude_score: number | null;
    claude_role_fit: string | null;
    claude_matched_reasons: unknown;
    claude_missing_skills: string[];
    claude_recommended: boolean | null;
    cv_status: string | null;
    cv_url: string | null;
    cl_status: string | null;
    cl_url: string | null;
  },
  offer: Offer,
  salaryPrefs: SalaryPref[],
  exchangeRates: Record<string, number>,
) {
  return {
    user_offer_id: userOffer.id,
    offer_id: offer.id,
    offer_title: offer.title,
    offer_company: offer.company_name,
    offer_url: offer.url,
    claude_score: userOffer.claude_score,
    claude_role_fit: userOffer.claude_role_fit,
    claude_matched_reasons: userOffer.claude_matched_reasons,
    claude_missing_skills: userOffer.claude_missing_skills,
    claude_recommended: userOffer.claude_recommended,
    required_skills: offer.required_skills,
    nice_to_have_skills: offer.nice_to_have_skills,
    salary: buildSalaryEntries(
      offer.employment_types,
      salaryPrefs,
      exchangeRates,
    ),
    source: offer.source,
    city: offer.city ?? null,
    work_model: offer.workplace_type ?? null,
    cv_status: userOffer.cv_status ?? null,
    cv_url: userOffer.cv_url ?? null,
    cl_status: userOffer.cl_status ?? null,
    cl_url: userOffer.cl_url ?? null,
  };
}

scanPageRouter.post('/', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!;
  if (role !== 'client') {
    return res
      .status(403)
      .json({
        error: 'FORBIDDEN',
        message: 'Only clients can use this endpoint',
      });
  }
  const userId = user_id!;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({
        error: 'INVALID_REQUEST',
        message: parsed.error.issues[0]?.message ?? 'Invalid body',
      });
  }
  const { page_text, page_url } = parsed.data;

  const [user, ratesSetting] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { profile: true, scan_page_counter: true, scan_page_counter_max: true, email: true },
    }),
    prisma.settings.findUnique({ where: { key: 'exchange_rates' } }),
  ]);

  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found');

  if (user.scan_page_counter_max > 0 && user.scan_page_counter >= user.scan_page_counter_max) {
    return res.status(402).json({ error: 'SCAN_LIMIT_REACHED' });
  }

  let exchangeRates: Record<string, number> = {};
  try {
    if (ratesSetting)
      exchangeRates = JSON.parse(ratesSetting.value) as Record<string, number>;
  } catch {
    /* rates stay empty */
  }

  const rawProfile = user.profile as unknown as {
    preferences?: {
      salary?: Array<{ type?: string; currency?: string; min?: number }>;
    };
  };
  const salaryPrefs: SalaryPref[] = (
    rawProfile.preferences?.salary ?? []
  ).filter(
    (p): p is SalaryPref =>
      p.type != null && p.currency != null && p.min != null,
  );

  const model = await getClaudeModel('scan_page_model');

  // Dedup check — if page_url is known, avoid re-parsing and re-matching an already-seen offer
  let offerForMatching: Offer | null = null;
  if (page_url) {
    const existingOffer = await prisma.offer.findFirst({
      where: { url: page_url },
    });
    if (existingOffer) {
      const existingUserOffer = await prisma.userOffer.findFirst({
        where: { user_id: userId, offer_id: existingOffer.id },
      });
      if (existingUserOffer) {
        // Case 1: offer + user_offer both exist — return as-is, no Claude calls
        return res.json({
          is_job_offer: true,
          user_offer: mapUserOfferResponse(
            existingUserOffer,
            existingOffer,
            salaryPrefs,
            exchangeRates,
          ),
        });
      }
      // Case 2: offer exists, user_offer does not — skip parsing, proceed to matching
      offerForMatching = existingOffer;
    }
  }

  // Validate profile (needed for matching in both Case 2 and Case 3)
  const profileParsed = CandidateProfileSchema.safeParse(user.profile);
  if (!profileParsed.success) {
    throw new AppError(
      422,
      'INVALID_PROFILE',
      'No valid profile configured for matching',
    );
  }

  // Case 3: no existing offer — parse the page and upsert the offer
  if (!offerForMatching) {
    const parseResponse = await anthropic.messages.create({
      model,
      max_tokens: 2000,
      system: [{ type: 'text', text: PARSE_SYSTEM_PROMPT }],
      tools: [PARSE_TOOL],
      tool_choice: { type: 'tool', name: 'parse_job_offer' },
      messages: [{ role: 'user', content: page_text.slice(0, 8000) }],
    });

    calculateCost(model, parseResponse.usage.input_tokens, parseResponse.usage.output_tokens)
      .then(cost => prisma.aiUsage.create({
        data: {
          user_id: userId,
          email: user.email ?? null,
          type: 'scan_page',
          model,
          input_tokens: parseResponse.usage.input_tokens,
          output_tokens: parseResponse.usage.output_tokens,
          cost,
        },
      }))
      .catch(err => console.error('[ai_usage] insert failed:', err));

    const toolUseBlock = parseResponse.content.find(
      b => b.type === 'tool_use',
    ) as Anthropic.ToolUseBlock | undefined;
    if (!toolUseBlock) {
      throw new AppError(
        500,
        'INTERNAL_ERROR',
        'Page parsing failed — no tool_use block returned',
      );
    }

    const parsedOffer = toolUseBlock.input as ParsedOffer;

    if (!parsedOffer.is_job_offer) {
      return res.json({ is_job_offer: false });
    }

    const title = parsedOffer.title ?? 'Unknown Title';
    const companyName = parsedOffer.company ?? 'Unknown Company';
    const offerUrl = page_url ?? parsedOffer.url ?? null;

    const slug = page_url
      ? `manual-${slugify(page_url, { lower: true, strict: true }).slice(0, 180)}`
      : `manual-${randomUUID()}`;

    const employmentType =
      parsedOffer.salary?.type === 'contract' ? 'contract' : 'permanent';
    const employmentTypes = parsedOffer.salary
      ? [
          {
            from: parsedOffer.salary.from ?? 0,
            to: parsedOffer.salary.to ?? 0,
            currency: parsedOffer.salary.currency ?? 'PLN',
            type: employmentType,
            unit: (parsedOffer.salary.unit ?? 'month').toLowerCase(),
          },
        ]
      : [];

    offerForMatching = await prisma.offer.upsert({
      where: { slug },
      create: {
        slug,
        source: 'manual',
        title,
        company_name: companyName,
        url: offerUrl,
        required_skills: parsedOffer.required_skills ?? [],
        nice_to_have_skills: parsedOffer.nice_to_have_skills ?? [],
        employment_types: employmentTypes,
        workplace_type: parsedOffer.workplace_type ?? null,
        city: parsedOffer.city ?? null,
        is_active: true,
        fetched_at: new Date(),
      },
      update: {
        title,
        company_name: companyName,
        url: offerUrl,
        required_skills: parsedOffer.required_skills ?? [],
        nice_to_have_skills: parsedOffer.nice_to_have_skills ?? [],
        employment_types: employmentTypes,
        workplace_type: parsedOffer.workplace_type ?? null,
        city: parsedOffer.city ?? null,
        fetched_at: new Date(),
      },
    });
  }

  // Match offer against user profile (Cases 2 and 3)
  const matchResult = await evaluateOffers(
    profileParsed.data,
    [offerForMatching],
    model,
  );
  if (!matchResult || matchResult.evaluations.length === 0) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Offer matching failed');
  }

  calculateCost(model, matchResult.input_tokens, matchResult.output_tokens)
    .then(cost => prisma.aiUsage.create({
      data: {
        user_id: userId,
        email: user.email ?? null,
        type: 'scan_page',
        model,
        input_tokens: matchResult.input_tokens,
        output_tokens: matchResult.output_tokens,
        cost,
      },
    }))
    .catch(err => console.error('[ai_usage] insert failed:', err));

  const evaluation = matchResult.evaluations[0]!;

  // Upsert user_offer
  const userOffer = await prisma.userOffer.upsert({
    where: {
      user_id_offer_id: { user_id: userId, offer_id: offerForMatching.id },
    },
    create: {
      user_id: userId,
      offer_id: offerForMatching.id,
      status: 'pending_apply',
      claude_score: evaluation.score,
      claude_role_fit: evaluation.role_fit,
      claude_matched_reasons: evaluation.matched_reasons,
      claude_missing_skills: evaluation.missing_skills,
      claude_recommended: evaluation.recommended,
      claude_salary_comparison: evaluation.salary_comparison,
    },
    update: {
      status: 'pending_apply',
      claude_score: evaluation.score,
      claude_role_fit: evaluation.role_fit,
      claude_matched_reasons: evaluation.matched_reasons,
      claude_missing_skills: evaluation.missing_skills,
      claude_recommended: evaluation.recommended,
      claude_salary_comparison: evaluation.salary_comparison,
    },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { scan_page_counter: { increment: 1 } },
  });

  return res.json({
    is_job_offer: true,
    user_offer: mapUserOfferResponse(
      userOffer,
      offerForMatching,
      salaryPrefs,
      exchangeRates,
    ),
  });
});
