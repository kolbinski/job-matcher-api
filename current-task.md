# Current Task

**Status:** 🟢 V1 Build — Step 2 in progress
**Last Updated:** 2026-06-03

---

## Active Build: JobMatcher API V1

### Goal
Ship a working `POST /v1/match` endpoint that:
1. Authenticates via `X-API-Key`
2. Deducts $0.10 from `users.credits` (atomic with `api_calls` insert)
3. Runs candidate profile through red flag filter
4. Scores remaining offers using the SPARK scoring algorithm
5. Calls Claude API for AI summaries on top 10 results
6. Returns matched + unmatched JSON per spec

---

## Build Plan (SPARK order)

### SPARK Step 1 — Schema Contract ✅
- [x] Initialize Railway PostgreSQL (Supabase) connection — `src/lib/prisma.ts` + `.env.example`
- [x] Write Prisma schema: `users`, `offers`, `api_calls`, `settings` — `prisma/schema.prisma`
- [ ] Write and run initial migration — needs real `DATABASE_URL`
- [x] Seed `settings` with `call_cost = 0.10`, `cronjob_interval_minutes = 10`, `ai_scoring_enabled = true` — `prisma/seed.ts`
- [x] Define Zod schema for `POST /v1/match` request body — `src/types/match.ts` + `src/types/profile.ts`
- [x] Define TypeScript types for `MatchResponse`, `MatchedOffer`, `UnmatchedOffer` — `src/types/match.ts`

### SPARK Step 2 — Payment Guard
- [ ] Implement API key validation middleware (`validateApiKey`)
  - Lookup key in `users` table
  - Return 401 for invalid/inactive keys
  - Attach `user` to `req` for downstream use
- [ ] Implement credits check middleware (`checkCredits`)
  - Read `call_cost` from `settings` table (never hardcode)
  - Return 402 `INSUFFICIENT_CREDITS` if `credits < call_cost`
- [ ] Implement billing transaction service (`billCall`)
  - `SELECT ... FOR UPDATE` on user row
  - Deduct credits + insert `api_calls` in one Prisma `$transaction`
  - `jm_test_` key path: skip deduction, write `cost = 0` record
- [ ] Write integration tests for billing (success, insufficient credits, rollback, test key)

### SPARK Step 3 — AI Pipeline
- [ ] Implement profile parser (JSON → internal `CandidateProfile` type)
- [ ] Implement red flag filter (`filterRedFlags`)
  - Input: candidate red_flags array + offer
  - Output: rejection_reasons array or null
  - Offers with rejection_reasons → `unmatched`, score = 0
- [ ] Implement scoring algorithm (`scoreOffer`)
  - `techScore * 0.40 + salaryScore * 0.25 + remoteScore * 0.20 + industryScore * 0.15`
  - `missing_skills`: diff between `offer.required_skills` and candidate technologies
- [ ] Implement Claude API integration (`generateAiSummary`)
  - Only for top 10 offers by score
  - Prompt: score + match_reasons + missing_skills → ai_summary + ai_recommendation
  - Timeout: 10s, fallback: omit `ai_summary`, set `ai_scoring: false` in meta
- [ ] Write tests for scoring (weight sum = 1.0, red flags produce score = 0)

### SPARK Step 4 — Reliability Layer
- [ ] Register `express-async-errors` at app entry point
- [ ] Implement standard error handler middleware
- [ ] Implement rate limiter (100 req/min per API key)
- [ ] Log response time to `api_calls.response_ms`
- [ ] Implement graceful shutdown (SIGTERM handler for Railway)
- [ ] Wire `GET /v1/health` health check

### SPARK Step 5 — Knowledge Capture
- [ ] Write OpenAPI spec for `POST /v1/match`
- [ ] Update `memory.md` with any schema decisions made during build
- [ ] Update `lessons.md` with any surprises
- [ ] Confirm Railway env vars: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `APIFY_API_TOKEN`

---

## Cronjob (parallel track)
- [ ] Implement Apify FalconScrape poller (`node-cron` + `apify-client`)
- [ ] Upsert logic: slug as primary key, `is_active = false` for missing offers
- [ ] Test: empty array response from Apify must NOT mark all offers inactive

---

## Working Memory

**Resolved:** Profile input format is JSON. The English spec is unambiguous — `POST /v1/match` body is a structured JSON object. No Markdown parsing needed in V1.

**Pending question:** Should credit deduction happen BEFORE or AFTER the Claude API call? 
- Before: user pays even if Claude times out (bad UX)
- After: user gets free calls if Claude is down (bad for business)
- Resolution: Deduct before, but roll back transaction if Claude returns non-retryable error. Claude timeout → 503, no charge.

**Pending question:** Apify cronjob — should it run inside the same Railway service or as a separate Railway cron job service?

---

## Next Action

Start SPARK Step 2: Payment Guard.
Begin with `validateApiKey` middleware — lookup `jobmatcher_api_key` in `users` table, attach user to `req`, return 401 on miss.

---

## Completed Steps

_(none yet — build not started)_
