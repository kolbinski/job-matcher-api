# Project Memory — JobMatcher API

Last reviewed: 2026-06-03

> Architectural decisions, schema facts, gotchas, and design patterns.
> Append-only within a category. Never delete — mark outdated entries with `[SUPERSEDED]`.
> No active task state (that lives in current-task.md). No personal data.

---

## Architecture Decisions

**[2026-06-03] Billing atomicity design**
Credit deduction (`UPDATE users SET credits = credits - cost`) and `api_calls` INSERT are wrapped in a single Prisma `$transaction`. The transaction uses `SELECT ... FOR UPDATE` on the user row to prevent race conditions when two concurrent requests both pass the credits check before either deducts.
*Why:* Two concurrent API calls with $0.15 remaining would both pass a credits check of $0.10, resulting in a -$0.05 balance and two `api_calls` records for one user.

**[2026-06-03] `call_cost` lives in DB, not env vars**
The `settings` table holds `call_cost` (and other tunables). This is read on every request — no caching. The business requirement is "price change without deploy." Cache invalidation introduces the same risk as hardcoding.
*Why:* Pricing changes need to take effect immediately for all in-flight Railway dynos, not just after a restart.

**[2026-06-03] Claude API called only on top 10 offers**
Red flag filter runs first (hard reject, score = 0). Then scoring algorithm runs on all remaining offers. Claude API is called only for top 10 by score.
*Why:* At scale (1,247 offers in DB), calling Claude on every offer would cost ~$0.37 per match call at current token rates — 3.7× the $0.10 call price.

**[2026-06-03] Profile input format is JSON, not Markdown**
Despite the spec's description mentioning "Markdown profile," the actual `POST /v1/match` request body is a structured JSON object (`profile` key). The Homo Digital agent workflow passes JSON. Markdown parsing is not needed for V1.

**[2026-06-03] Two API key modes**
- `jm_live_` prefix: production key, deducts credits
- `jm_test_` prefix: test key, no credit deduction, returns mock data, still writes `api_calls` row with `cost = 0`
*Why:* Enables integration testing by API clients without burning real credits. Analogous to Stripe's `sk_test_` / `sk_live_` pattern.

**[2026-06-03] Scoring weights are V1-immutable**
`techScore * 0.40 + salaryScore * 0.25 + remoteScore * 0.20 + industryScore * 0.15`
Weight changes are a breaking change — they alter the `score` field in API responses that clients may be storing. Any weight change in V2+ requires a migration note and changelog entry.

**[2026-06-03] Apify FalconScrape as sole data source for V1**
Actor ID: `falconscrape/just-join-it-scraper`. Estimated cost: $5-15/month at 10-minute intervals.
V2 adds NoFluffJobs. V3 adds RemoteOK (free API). V4 adds Wellfound + Dice.
*Gotcha:* Apify returns `requiredSkills` (camelCase) but DB stores `required_skills` (snake_case). Normalize in the scraper service, not in the scoring algorithm.

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
