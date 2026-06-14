import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import slugify from 'slugify'
import { prisma } from '../lib/prisma'
import { validateJwt } from '../middleware/validateJwt'
import { getClaudeModel } from '../lib/claudeModels'
import { CandidateProfileSchema } from '../types/profile'
import { evaluateOffers } from '../services/claudeEvaluator'
import { AppError } from '../lib/errors'

export const scanPageRouter = Router()

const anthropic = new Anthropic()

const BodySchema = z.object({
  page_text: z.string().min(1),
})

const PARSE_SYSTEM_PROMPT = 'You are a job offer parser. Extract structured data from the provided page text. If the page is not a job offer, set is_job_offer to false and all other fields to null/empty.'

const PARSE_TOOL: Anthropic.Tool = {
  name: 'parse_job_offer',
  description: 'Extract structured job offer data from the page text.',
  input_schema: {
    type: 'object',
    properties: {
      is_job_offer:       { type: 'boolean' },
      title:              { type: ['string', 'null'] },
      company:            { type: ['string', 'null'] },
      url:                { type: ['string', 'null'] },
      salary: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type:     { type: 'string' },
              currency: { type: 'string' },
              from:     { type: ['number', 'null'] },
              to:       { type: ['number', 'null'] },
            },
            required: ['type', 'currency'],
          },
          { type: 'null' },
        ],
      },
      required_skills:    { type: 'array', items: { type: 'string' } },
      nice_to_have_skills: { type: 'array', items: { type: 'string' } },
      workplace_type:     { type: ['string', 'null'], enum: ['remote', 'hybrid', 'office', null] },
      city:               { type: ['string', 'null'] },
      employment_type:    { type: ['string', 'null'] },
      description:        { type: ['string', 'null'] },
    },
    required: ['is_job_offer'],
  },
}

interface ParsedOffer {
  is_job_offer: boolean
  title: string | null
  company: string | null
  url: string | null
  salary: { type: string; currency: string; from: number | null; to: number | null } | null
  required_skills: string[]
  nice_to_have_skills: string[]
  workplace_type: 'remote' | 'hybrid' | 'office' | null
  city: string | null
  employment_type: string | null
  description: string | null
}

scanPageRouter.post('/', validateJwt, async (req, res) => {
  const { role, user_id } = req.jwt!
  if (role !== 'client') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only clients can use this endpoint' })
  }
  const userId = user_id!

  const parsed = BodySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'INVALID_REQUEST', message: parsed.error.issues[0]?.message ?? 'Invalid body' })
  }
  const { page_text } = parsed.data

  // Limit check
  const [user, subscription] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { profile: true, scan_page_counter: true },
    }),
    prisma.subscription.findFirst({
      where: { user_id: userId },
      include: { plan: true },
    }),
  ])

  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'User not found')

  const limits = subscription?.plan?.limits as
    | { max_apply_now: number | null; max_level_up: number | null; max_scan_page: number | null }
    | null

  if (limits?.max_scan_page != null && user.scan_page_counter >= limits.max_scan_page) {
    return res.status(402).json({ error: 'SCAN_LIMIT_REACHED' })
  }

  const model = await getClaudeModel('scan_page_model')

  // Step 1: Parse the page with Claude
  const parseResponse = await anthropic.messages.create({
    model,
    max_tokens: 2000,
    system: [{ type: 'text', text: PARSE_SYSTEM_PROMPT }],
    tools: [PARSE_TOOL],
    tool_choice: { type: 'tool', name: 'parse_job_offer' },
    messages: [{ role: 'user', content: page_text.slice(0, 8000) }],
  })

  const toolUseBlock = parseResponse.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined
  if (!toolUseBlock) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Page parsing failed — no tool_use block returned')
  }

  const parsedOffer = toolUseBlock.input as ParsedOffer

  if (!parsedOffer.is_job_offer) {
    return res.json({ is_job_offer: false })
  }

  // Validate user has a profile for matching
  const profileParsed = CandidateProfileSchema.safeParse(user.profile)
  if (!profileParsed.success) {
    throw new AppError(422, 'INVALID_PROFILE', 'No valid profile configured for matching')
  }

  // Upsert offer into offers table
  const title = parsedOffer.title ?? 'Unknown Title'
  const companyName = parsedOffer.company ?? 'Unknown Company'
  const offerUrl = parsedOffer.url ?? null

  const slug = offerUrl
    ? `manual-${slugify(offerUrl, { lower: true, strict: true }).slice(0, 180)}`
    : `manual-${randomUUID()}`

  const employmentTypes = parsedOffer.salary
    ? [{ from: parsedOffer.salary.from ?? 0, to: parsedOffer.salary.to ?? 0, currency: parsedOffer.salary.currency, type: parsedOffer.salary.type }]
    : []

  const offer = await prisma.offer.upsert({
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
  })

  // Step 2: Match offer against user profile
  const matchResult = await evaluateOffers(profileParsed.data, [offer], model)
  if (!matchResult || matchResult.evaluations.length === 0) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Offer matching failed')
  }
  const evaluation = matchResult.evaluations[0]!

  // Upsert user_offer (unique on user_id + offer_id)
  const userOffer = await prisma.userOffer.upsert({
    where: { user_id_offer_id: { user_id: userId, offer_id: offer.id } },
    create: {
      user_id: userId,
      offer_id: offer.id,
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
  })

  // Increment scan_page_counter
  await prisma.user.update({
    where: { id: userId },
    data: { scan_page_counter: { increment: 1 } },
  })

  return res.json({
    is_job_offer: true,
    user_offer: {
      id: userOffer.id,
      offer_id: offer.id,
      claude_score: evaluation.score,
      claude_role_fit: evaluation.role_fit,
      claude_matched_reasons: evaluation.matched_reasons,
      claude_missing_skills: evaluation.missing_skills,
      claude_recommended: evaluation.recommended,
      offer: {
        title: offer.title,
        company: offer.company_name,
        url: offer.url,
        salary: parsedOffer.salary,
        required_skills: offer.required_skills,
        workplace_type: offer.workplace_type,
        city: offer.city,
      },
    },
  })
})
