import { z } from 'zod'
import { CandidateProfileSchema } from './profile'

// ─── Request schemas ─────────────────────────────────────────────────────────

export const MatchFiltersSchema = z.object({
  min_score: z.number().int().min(0).max(100).optional(),
  salary_min: z.number().nonnegative().optional(),
  salary_max: z.number().nonnegative().optional(),
  currency: z.string().min(3).max(3).optional(),
  remote: z.boolean().optional(),
  hybrid: z.boolean().optional(),
  cities: z.array(z.string()).optional(),
  country_code: z.string().min(2).max(2).optional(),
  experience_level: z
    .array(z.enum(['junior', 'mid', 'senior', 'c-level', 'expert']))
    .optional(),
  employment_type: z
    .enum(['b2b', 'uop', 'uz', 'mandate', 'internship'])
    .optional(),
  sources: z.array(z.string()).optional(),
})

export const MatchSortSchema = z.object({
  field: z.enum(['score']).default('score'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export const MatchOptionsSchema = z.object({
  include_unmatched: z.boolean().default(false),
  ai_scoring: z.boolean().default(true),
})

export const MatchRequestSchema = z.object({
  profile: CandidateProfileSchema,
  filters: MatchFiltersSchema.optional(),
  sort: MatchSortSchema.optional(),
  options: MatchOptionsSchema.optional(),
})

export type MatchRequest = z.infer<typeof MatchRequestSchema>
export type MatchFilters = z.infer<typeof MatchFiltersSchema>

// ─── Response types ───────────────────────────────────────────────────────────

export interface MatchMeta {
  call_id: string
  generated_at: string
  response_ms: number
  total_offers_scanned: number
  matched_count: number
  unmatched_count: number
  ai_scoring: boolean
}

export interface OfferSalary {
  from: number
  to: number
  currency: string
  type: string
}

export interface ScoreBreakdown {
  techScore: number
  salaryScore: number
  remoteScore: number
  industryScore: number
}

export interface MatchedOffer {
  score: number
  score_breakdown: ScoreBreakdown
  title: string
  company: string
  city: string | null
  remote: boolean
  hybrid: boolean
  experience_level: string | null
  salary: OfferSalary | null
  matched_reasons: string[]
  missing_skills: string[]
  red_flags_found: string[]
  ai_summary: string | null
  ai_recommendation: 'apply' | 'consider' | 'skip' | null
  url: string | null
  source: string
  fetched_at: string | null
}

export interface UnmatchedOffer {
  score: 0
  title: string
  company: string
  city: string | null
  remote: boolean
  hybrid: boolean
  salary: OfferSalary | null
  rejection_reasons: string[]
  required_skills: string[]
  url: string | null
  source: string
}

export interface MatchResponse {
  meta: MatchMeta
  matched: MatchedOffer[]
  unmatched: UnmatchedOffer[]
}
