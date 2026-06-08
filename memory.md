# Project Memory — JobMatcher API

Last reviewed: 2026-06-03

> Architectural decisions, schema facts, gotchas, and design patterns.
> Append-only within a category. Never delete — mark outdated entries with `[SUPERSEDED]`.
> No active task state (that lives in current-task.md). No personal data.

---

## Architecture Decisions

**[2026-06-03] Billing atomicity design** [SUPERSEDED — see entry below]
Credit deduction and `api_calls` INSERT are wrapped in a single Prisma `$transaction`. Originally planned to use `SELECT ... FOR UPDATE` for race condition prevention.
*Superseded by:* Supabase PgBouncer blocks raw UUID casts via `$queryRaw`, making `SELECT ... FOR UPDATE` unworkable. See corrected entry below.

**[2026-06-03] Billing atomicity design — ACTUAL IMPLEMENTATION**
Credit deduction and `api_calls` INSERT are wrapped in a single Prisma `$transaction`. Race condition prevention uses a **conditional `updateMany`**: `UPDATE users SET credits = credits - cost WHERE id = $id AND credits >= cost`. If `updateMany` returns `count = 0`, the transaction aborts with `INSUFFICIENT_CREDITS`.
*Why:* `SELECT ... FOR UPDATE` requires `$queryRaw` with `::uuid` cast, which fails through Supabase PgBouncer in transaction mode (`operator does not exist: text = uuid`). The conditional UPDATE is atomic at the row level and achieves the same correctness guarantee without raw SQL.

**[2026-06-03] `call_cost` lives in DB, not env vars**
The `settings` table holds `call_cost` (and other tunables). This is read on every request — no caching. The business requirement is "price change without deploy." Cache invalidation introduces the same risk as hardcoding.
*Why:* Pricing changes need to take effect immediately for all in-flight Railway dynos, not just after a restart.

**[2026-06-03] Claude API called only on top 10 offers**
Red flag filter runs first (hard reject, score = 0). Then scoring algorithm runs on all remaining offers. Claude API is called only for top 10 by score.
*Why:* At scale (1,247 offers in DB), calling Claude on every offer would cost ~$0.37 per match call at current token rates — 3.7× the $0.10 call price.

**[2026-06-03] Claude model and failure behavior**
Model: `claude-sonnet-4-6`. Timeout: 10s. On timeout or non-retryable error: return `null` for the AI summary field and roll back the billing transaction — return 503 to client, no charge.
*Why:* Null fallback prevents a Claude outage from breaking the entire match response. The summary field is enrichment, not a correctness requirement.

**[2026-06-03] Profile input format is JSON, not Markdown**
Despite the spec's description mentioning "Markdown profile," the actual `POST /v1/match` request body is a structured JSON object (`profile` key). The Homo Digital agent workflow passes JSON. Markdown parsing is not needed for V1.

**[2026-06-03] Two API key modes**
- `jm_live_` prefix: production key, deducts credits
- `jm_test_` prefix: test key, no credit deduction, returns mock data, still writes `api_calls` row with `cost = 0`
*Why:* Enables integration testing by API clients without burning real credits. Analogous to Stripe's `sk_test_` / `sk_live_` pattern.

**[2026-06-03] Red flag filter categories (V1)**
Three hard-reject categories: `technology` (legacy/outsourcing stack), `salary` (missing or below threshold), `work_model` (fully on-site when candidate requires remote). All red-flagged offers get `score = 0` and appear in `unmatched` with `reason` field.
*Why:* Keeping categories explicit and named (not a generic `reasons[]`) allows clients to build UI that explains why an offer was rejected.

**[2026-06-03] Scoring weights are V1-immutable**
`techScore * 0.40 + salaryScore * 0.25 + remoteScore * 0.20 + industryScore * 0.15`
Weight changes are a breaking change — they alter the `score` field in API responses that clients may be storing. Any weight change in V2+ requires a migration note and changelog entry.

**[2026-06-03] Apify FalconScrape as sole data source for V1**
Actor ID: `falconscrape/just-join-it-scraper`. Estimated cost: $5-15/month at 10-minute intervals.
V2 adds NoFluffJobs. V3 adds RemoteOK (free API). V4 adds Wellfound + Dice.
*Gotcha:* Apify returns `requiredSkills` (camelCase) but DB stores `required_skills` (snake_case). Normalize in the scraper service, not in the scoring algorithm.

**[2026-06-03] Railway/Supabase connection — Supavisor session mode**
Database connection uses Supabase Supavisor pooler in **session mode** (port 5432 on the pooler host). The direct Supabase host port is blocked on Railway. Migrations are run via Supavisor session mode, not transaction mode, because `ALTER TYPE` and other DDL statements are incompatible with transaction-mode pooling.
*Why:* Railway firewall blocks the direct Supabase connection. Supavisor port 5432 (session mode) is the only reliable path for both migrations and runtime queries.

**[2026-06-03] Rate limiter — in-memory for V1**
`express-rate-limit` with in-memory store. Limit: 100 req/min per API key (keyed by `X-API-Key` header). No Redis.
*Why:* Railway V1 runs a single dyno. In-memory rate limiting is exact at single-instance scale. Redis adds operational cost and complexity that's only justified when running multiple dynos. Migrate to Redis when Railway auto-scaling is enabled.

**[2026-06-03] response_ms logging placement**
`api_calls.response_ms` is recorded inside `billCall` at the **end** of the route handler, just before `res.json()`. It is NOT recorded in a middleware (which would capture total Express overhead, not business logic time).
*Why:* We want to measure time from auth-validated request to scored response — the duration that reflects actual pipeline performance, not network/middleware overhead.

**[2026-06-03] `is_active` flag strategy**
Offers that don't appear in the latest Apify fetch are marked `is_active = false`. However: if Apify returns an empty array (e.g., rate-limited or API error), we must NOT set all offers inactive. Guard: only run the `is_active = false` update if the fetch returned > 0 offers.

---

## Schema Facts

**`settings` table seed values (V1)**
```
call_cost                  = '0.10'
cronjob_interval_minutes   = '10'
ai_scoring_enabled         = 'true'
```

**`offers` table key decisions**
- Primary key: `slug` (VARCHAR) — format `company-title-city-technology`, from JustJoin
- `required_skills`: `TEXT[]` — array of strings, NOT objects with skill levels
- `employment_types`: `JSONB` — preserves Apify's nested salary structure
- `multilocation`: `JSONB` — array of location objects
- `category_id`: stored but not used in V1 scoring

**`api_calls` table**
- `profile_hash` (VARCHAR): SHA-256 of the JSON profile string — used for deduplication analytics, not for caching
- `cost`: DECIMAL(10,4) — snapshot of `settings.call_cost` at call time (not a foreign key to settings)

**`users` table**
- `jobmatcher_api_key`: 32 random chars after `jm_live_` or `jm_test_` prefix
- `credits`: DECIMAL(10,4) — can go slightly negative due to floating point; treat < 0 as 0 in API responses

**`POST /v1/match` request shape — four top-level keys**
```
profile     — full candidate JSON object (basic_info, career_goals, technologies, red_flags, etc.)
filters     — optional query constraints: min_score, salary_min, salary_max, currency, remote,
              hybrid, cities[], country_code, experience_level[], employment_type, sources[]
sort        — { field: "score", order: "desc" }
options     — { limit: 20, include_unmatched: true, ai_scoring: true }
```
`filters` is applied AFTER red flag filtering and scoring — it narrows the result set, it does not replace the scoring algorithm. `min_score` is a post-score cutoff, not a skip-scoring flag.

**Endpoints in V1**
- `POST /v1/match` — main matching call
- `GET /v1/health` — status + offers count + last cronjob timestamp (NOT `/v1/status`)
- `GET /v1/sources` — available job board sources and their status
- `GET /v1/credits` — account balance (V1, authenticated)
- `GET /v1/calls` — call history (V1, authenticated)

---

## Integration Patterns

**Stripe auto-refill flow**
1. `POST /v1/match` completes, credits deducted
2. After transaction commits, check: `if (user.credits < user.auto_refill_threshold && user.auto_refill)`
3. Trigger Stripe charge for `auto_refill_amount` using stored `stripe_payment_method`
4. On `payment_intent.succeeded` webhook: add credits to user account
5. Webhook must be idempotent — store `stripe_event_id` in a processed-events table or use Stripe's event idempotency key

**Homo Digital agent integration**
JobMatcher API is called as part of the Homo Digital agent workflow:
`CandidateProfile (JSON) → POST /v1/match → scored offers list → agent reviews → agent applies`
The `missing_skills` field across API calls is aggregated to build training/certification recommendations.

---

## Gotchas & Pitfalls

**[2026-06-03] Apify empty array on rate limit**
FalconScrape returns an empty array (not an error) when rate-limited. Without a guard, this would set all offers to `is_active = false`. Always check `offers.length > 0` before running the deactivation query.

**[2026-06-03] Salary comparison currency mismatch**
Apify returns `fromUsd` and `toUsd` pre-converted. For `salaryScore`, use USD values for consistent comparison when the candidate's target is in PLN. Conversion: read the exchange rate from the `employment_types.currency` field, not from a hardcoded rate.

**[2026-06-03] `required_skills` case sensitivity**
JustJoin skill names are inconsistent: `"React"`, `"react"`, `"ReactJS"` all appear. Normalize to lowercase before skill matching. The candidate profile `technologies[].name` should also be lowercased before diff.

**[2026-06-03] Railway cold starts**
Railway restarts the dyno on deploy. In-flight requests during restart are dropped. Graceful shutdown handler (SIGTERM → drain in-flight requests → close DB pool) prevents this from causing mid-request billing state corruption.

---

## Project Evolution

**V1 scope** (current): JustJoin.it via Apify, `POST /v1/match`, credits + Stripe, Railway deploy
**V2 planned**: NoFluffJobs scraper, `GET /v1/credits`, `GET /v1/calls`, user dashboard
**V3 planned**: RemoteOK (free API), international filtering, IP rotation for scraping
**V4 planned**: Wellfound (AngelList), Dice.com — US market expansion

---

## Test Architecture

**[2026-06-06] Offer findMany spy pattern for fast integration tests**
`tests/match.test.ts` and `tests/stretchOffers.test.ts` spy on `prisma.offer.findMany` in `beforeAll` to return a small controlled set of offers (6 fixture records) instead of 8000+ live rows. This reduces test time from 241s to ~51s while keeping all real DB assertions (userOffer, apiCall, user).
*Fixture slugs:* `test-match-fixture-*` — created in `beforeAll`, deleted in `afterAll`.
*Deduplication test* (requires real seenIds behaviour) lives in `tests/integration/match-deduplication.test.ts`, excluded from default `vitest run` and run via `npm run test:integration`.
*Remaining bottleneck:* Supabase network latency (~300ms/round-trip). Getting below 30s would require a local test DB or fully mocking user/userOffer/apiCall calls too.

**[2026-06-06] Batched Claude evaluation (no cap)** [SUPERSEDED — see per-batch insertion entry below]
`matchService.ts` step 8 processes all filtered offers in BATCH_SIZE=100 chunks rather than capping at 100. `claudeBySlug` Map keyed by slug merges results across batches.

**[2026-06-06] Per-batch user_offers insertion**
Claude evaluations in `matchService.ts` step 8 are now applied and persisted immediately after each 100-offer batch, rather than accumulating into a `claudeBySlug` Map and bulk-inserting after all batches complete. The `ClaudeEvaluation` import was removed (Map no longer needed). Each batch: evaluate → apply to pairs in-place → `createMany` with `skipDuplicates: true` → log. Final sort by Claude score happens once after all batches.
*Why:* A mid-run Claude failure previously lost all progress. With per-batch insertion, already-processed batches remain in `user_offers` so the next sync's `seenIds` is larger and Claude re-evaluates fewer offers.

**[2026-06-06] Email "Worth considering" capped at 3**
`buildEmailReport` in `emailReport.ts` caps the "Worth considering" section to `sortedConsider.slice(0, 3)`. Header changed from `💡 Worth considering (N offers)` to `💡 Top N worth considering` where N = `Math.min(actual, 3)`.
*Why:* Email readability — agents don't need a full list of borderline offers, just the best 3.

**[2026-06-06] pre_filter_rejected rows written before Claude (step 6b)**
Pre-filter rejected rows are written to `user_offers` immediately after filtering (before Claude runs), so `seenIds` on the next sync already excludes them. Prevents re-evaluation of known-rejected offers.

**[2026-06-06] SSE /v1/sync/progress removed**
Replaced by client-side polling of `GET /v1/sync/status`. Removed jwt/env imports from `src/routes/sync.ts`.

**[2026-06-06] total_offers_scanned in SyncJob**
`SyncJob` interface and `runJob` accumulate `total_offers_scanned` per client from `result.meta.total_offers_scanned`. Used in email report ("Today I scanned X new offers").

**[2026-06-08] FK guard before user_offers createMany**
Both pre_filter_rejected and claude batch insertions in `matchService.ts` now do a `prisma.offer.findMany({ where: { id: { in: [...] } }, select: { id: true } })` existence check first. Rows whose offer_id is no longer in the offers table are filtered out with a `console.warn`. This prevents FK constraint violations when an offer is deleted between the step-4 scan and the step-6b/8 insert.
*Gotcha:* The `findMany` spy in `tests/match.test.ts` intercepts `select: { id: true }` queries and returns `[]`. Fixed by adding `if (args?.where?.id?.in) return origFindMany(args)` as the first branch in the mock so existence-check queries pass through to the real DB.

**[2026-06-08] user_syncs table — structured report persistence**
`user_syncs` (id, user_id, report JSONB, created_at) stores a structured report per sync run per user. Report shape: `{scanned: number, worth_applying: OfferEntry[], level_up: (OfferEntry & {skills_to_learn})[],  worth_considering: OfferEntry[]}`. Built by `buildSyncReport()` in `src/services/syncReport.ts`. Saved in `syncService.ts` before `sendMatchReport()` so the record exists even if email delivery fails.
`OfferEntry` = `{score, title, company, work_model: 'remote'|'hybrid'|'office'|null, city, salary: SalaryEntry[], role_fit, url}`
`SalaryEntry` = `{min, max, currency, type, delta, delta_normalized}` — delta/delta_normalized computed the same way as `buildSalaryEntries` in `userOffers.ts`. Exchange rates loaded once per job from `settings.exchange_rates`; falls back to rate=1 (delta_normalized=delta) if key missing.
