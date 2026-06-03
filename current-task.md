# Current Task

**Status:** 🟢 V1 Build — Step 4 complete, Step 5 starting
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
- [x] Write and run initial migration — `20260603111352_init` applied via Supavisor session mode (port 5432 on pooler host; direct host port blocked)
- [x] Seed `settings` with `call_cost = 0.10`, `cronjob_interval_minutes = 10`, `ai_scoring_enabled = true` — `prisma/seed.ts`
- [x] Define Zod schema for `POST /v1/match` request body — `src/types/match.ts` + `src/types/profile.ts`
- [x] Define TypeScript types for `MatchResponse`, `MatchedOffer`, `UnmatchedOffer` — `src/types/match.ts`

### SPARK Step 2 — Payment Guard ✅
- [x] Implement API key validation middleware (`validateApiKey`) — `src/middleware/validateApiKey.ts`
- [x] Implement credits check middleware (`checkCredits`) — `src/middleware/checkCredits.ts`
- [x] Implement billing transaction service (`billCall`) — `src/services/billing.ts`
  - Used conditional `updateMany WHERE credits >= cost` instead of `SELECT ... FOR UPDATE` (PgBouncer blocks raw UUID cast via $queryRaw)
- [x] Write integration tests for billing (success, insufficient credits, rollback, test key) — `tests/billing.test.ts` (11 tests, all green)

### SPARK Step 3 — AI Pipeline ✅
- [x] Implement profile parser — `src/services/profileParser.ts` (normalizes techs to lowercase, infers experience level)
- [x] Implement red flag filter — `src/services/redFlagFilter.ts` (technology, salary, work_model categories)
- [x] Implement scoring algorithm — `src/services/scoring.ts` (`techScore*0.40 + salaryScore*0.25 + remoteScore*0.20 + industryScore*0.15`)
- [x] Implement Claude API integration — `src/services/aiSummary.ts` (`claude-sonnet-4-6`, 10s timeout, null fallback)
- [x] Tests — `tests/scoring.test.ts` (18 new tests: weights sum, red flags, techScore, remoteScore, salaryScore)

### SPARK Step 4 — Reliability Layer ✅
- [x] `express-async-errors` + standard error handler — already in `src/app.ts` (Step 2)
- [x] Graceful shutdown (SIGTERM) — already in `src/index.ts` (Step 2)
- [x] Rate limiter — `src/middleware/rateLimiter.ts` (100 req/min per API key, in-memory)
- [x] Response time logged to `api_calls.response_ms` via `billCall` at end of route handler
- [x] `GET /v1/health` — `src/routes/health.ts` (status + active offers count + last cronjob)
- [x] `POST /v1/match` — `src/routes/match.ts` (full pipeline: auth → credits → rate limit → parse → filter → score → AI → bill → respond)
- [x] Tests — `tests/health.test.ts` + `tests/match.test.ts` (8 new integration tests: 401/422/200, billing, credits deduction, 402)

### SPARK Step 5 — Knowledge Capture
- [ ] Write OpenAPI spec for `POST /v1/match`
- [ ] Update `memory.md` with any schema decisions made during build
- [ ] Update `lessons.md` with any surprises
- [ ] Confirm Railway env vars: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `APIFY_API_TOKEN`

---

## Cronjob (parallel track) ✅
- [x] Implement Apify FalconScrape poller (`node-cron` + `apify-client`) — `src/services/apifyScraper.ts` + `src/lib/scheduler.ts`
- [x] Upsert logic: slug as primary key, `is_active = false` for missing offers — `src/jobs/offerSync.ts`
- [x] Test: empty array response from Apify must NOT mark all offers inactive — `tests/offerSync.test.ts` (9 tests, all green)
  - Scheduler starts with immediate run on boot, then every `settings.cronjob_interval_minutes` (default 10)
  - In-progress lock prevents overlapping runs
  - Paginated dataset fetch (1000 items/page) for large actor results
  - `NODE_ENV=test` guard prevents scheduler from starting during Vitest runs

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
