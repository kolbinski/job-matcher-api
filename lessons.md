# Lessons Learned — JobMatcher API

Last reviewed: 2026-06-03

> Prevention rules derived from real mistakes and near-misses. Read at session start, update after every correction.
> Format: **Rule** → **Why** (incident or anticipated failure) → **How to apply** (trigger condition).

---

## Billing & Payments

**RULE B-1: Always use a DB transaction for credit deduction + call logging.**
**Why:** Two concurrent requests that both pass a credits check before either deducts will put the user in negative credits and write two call records for one user intent. This is not a theoretical race — at 100 req/min rate limit, two requests from the same key in the same 10ms window is likely.
**How to apply:** Any code path that touches `users.credits` must open a Prisma `$transaction` first. No exceptions.

**RULE B-2: Read `call_cost` from the `settings` table on every request.**
**Why:** Caching `call_cost` (in memory or env var) means a price change doesn't take effect until all Railway dynos restart. The `settings` table exists specifically to enable runtime price changes.
**How to apply:** Any service that bills a call must do `await prisma.settings.findUnique({ where: { key: 'call_cost' } })` inside the transaction, not before it.

**RULE B-3: Stripe webhook handlers must be idempotent.**
**Why:** Stripe retries events on network failure. A `payment_intent.succeeded` event that credits a user's account must not fire twice and add credits twice. This will happen on the first deploy.
**How to apply:** Before processing any Stripe event, check if `stripe_event_id` has been processed before. Use a `stripe_events` table or Stripe's built-in idempotency key. Reject duplicates with 200 OK (not 4xx — Stripe will retry 4xx).

**RULE B-4: `jm_test_` keys must still write to `api_calls` with `cost = 0`.**
**Why:** Usage analytics and debugging depend on `api_calls` being a complete record of all API activity. A gap in test calls makes it impossible to distinguish "user didn't call" from "user called with test key."
**How to apply:** The test key billing path is a shortcut inside the transaction, not a bypass of the transaction.

---

## AI Pipeline

**RULE A-1: Run red flag filter BEFORE calling Claude API.**
**Why:** Calling Claude on all 1,247 offers in the DB would cost ~$0.37 per match call — 3.7× the $0.10 revenue. The red flag filter is CPU-only and eliminates outsourcing firms, missing salary, and legacy stacks before any AI cost is incurred.
**How to apply:** The pipeline order is: authenticate → check credits → parse profile → red flag filter → score → Claude (top 10 only) → respond. Never move Claude before the filter.

**RULE A-2: Claude API timeout must roll back the billing transaction.**
**Why:** If Claude times out at 10s, the user has been kept waiting and should not be charged. Charging for a failed AI call is a trust-destroying billing error.
**How to apply:** The billing transaction is opened before the Claude call. If Claude throws a timeout (or any non-retryable error), the transaction is rolled back. Return 503 with `ai_scoring: false` in the response meta.

**RULE A-3: Normalize skill names to lowercase before matching.**
**Why:** JustJoin returns `"React"`, `"react"`, `"ReactJS"`, and `"React.js"` for the same technology. Without normalization, a senior React dev shows 0% tech score on a React job because of string case mismatch.
**How to apply:** In the profile parser and the Apify scraper service, run `skills.map(s => s.toLowerCase().trim())` before any comparison.

**RULE A-4: Guard the Apify empty-array case before marking offers inactive.**
**Why:** Apify returns an empty array (not an HTTP error) when rate-limited or when the actor fails silently. Running `UPDATE offers SET is_active = false WHERE slug NOT IN (...)` with an empty `NOT IN` list deactivates the entire offers table.
**How to apply:** `if (fetchedOffers.length === 0) { log.warn('Apify returned 0 offers — skipping deactivation'); return; }`

---

## Security

**RULE S-1: Never log the raw API key.**
**Why:** Railway logs are visible to anyone with service access. An API key in a log line is a credential leak waiting to happen.
**How to apply:** In all middleware and error handlers, replace the API key with a masked version: `jm_live_****` (first 8 chars + mask). Grep for `jm_live_` and `jm_test_` in log output as part of OV.

**RULE S-2: Validate and reject malformed API keys at the middleware level, not in routes.**
**Why:** Route-level auth checks get duplicated and forgotten. A middleware that runs before all routes ensures no endpoint is accidentally unauthenticated.
**How to apply:** `validateApiKey` middleware is registered in `app.use()` before any route. Individual routes do NOT re-check auth.

---

## TypeScript & Code Quality

**RULE T-1: Monetary values use `Decimal` (Prisma) in DB and 4dp `number` in business logic.**
**Why:** Floating point arithmetic on monetary values produces billing errors. `0.1 + 0.2 === 0.30000000000000004` in JavaScript.
**How to apply:** Never use plain `+` or `-` on credit amounts. Use Prisma's `Decimal` type for DB operations and `Math.round(value * 10000) / 10000` when converting to number for responses.

**RULE T-2: Define Zod schemas for environment variables at startup.**
**Why:** A missing `ANTHROPIC_API_KEY` discovered at request time (when the first Claude call fails) is harder to debug than one discovered at startup.
**How to apply:** In `src/lib/env.ts`, parse all required env vars with Zod. If any are missing, throw with a clear message and exit. This runs before the Express server starts.

---

## Deployment

**RULE D-1: Add a SIGTERM handler before deploying to Railway.**
**Why:** Railway sends SIGTERM before killing the process. Without a handler, in-flight requests are dropped mid-execution. For a billing API, this means a request that passed the credits check but hasn't committed the transaction yet will deduct credits with no record.
**How to apply:** Register `process.on('SIGTERM', gracefulShutdown)` that closes the HTTP server (stops accepting new connections) and waits for in-flight requests to complete before closing the DB connection pool.

**RULE D-2: New env vars must be added to Railway before merging.**
**Why:** A Railway deploy that starts successfully but fails on the first request because `STRIPE_WEBHOOK_SECRET` isn't set is indistinguishable from a code bug to the user.
**How to apply:** OV checklist item: "Confirm all new env vars are set in Railway service variables." Add to pre-deploy PR checklist.

---

## Process

**RULE P-1: Don't start SPARK Step 3 (AI Pipeline) until Step 2 (Payment Guard) has passing tests.**
**Why:** The AI pipeline is interesting to build. The billing guard is boring. This is exactly why the billing guard gets "I'll do it after" treatment — and then the interesting code ships without the guard.
**How to apply:** `current-task.md` checkboxes enforce order. Mark Step 2 tests as complete before opening any Claude API integration code.

**RULE P-2: When the spec says "optional," treat it as "required for correctness."**
**Why:** The `profile_hash` field in `api_calls` looks optional. But without it, you can't detect when a user is calling the API with identical profiles (automation loop bug) or build deduplication analytics.
**How to apply:** Read the spec's rationale, not just the field list. If a field has a stated purpose, implement it in V1.

**RULE P-3: `filters` narrows results — it does NOT replace the scoring algorithm.**
**Why:** The `POST /v1/match` request has a `filters` object (`min_score`, `salary_min`, `salary_max`, `cities`, `sources`, etc.). A natural misread is to implement filtering as a DB WHERE clause that bypasses scoring entirely. The correct pipeline is: red flag filter → score all offers → apply `filters` as a post-score cutoff on the scored result set.
**How to apply:** In the route handler, `filters.min_score` is checked after `scoreOffer()` returns, not before. The scoring algorithm always runs on all non-red-flagged offers regardless of filters.

**RULE T-3: Zod v4 breaking changes vs v3.**
Three API changes that silently break v3 code under v4:
1. `z.record(ValueSchema)` → must be `z.record(z.string(), ValueSchema)` — key type is now required
2. `z.string().length(n)` → must be `z.string().min(n).max(n)` — single-arg overload removed
3. `.nonneg()` → `.nonnegative()` — shorthand removed

**Why:** These are TypeScript errors at compile time (not runtime surprises), but they block `tsc --noEmit` on first compile. Always run `tsc --noEmit` after installing a new Zod major version before writing any business logic.
**How to apply:** When starting a project with Zod, add a `tsc --noEmit` step to the SPARK Step 1 checklist to catch version incompatibilities before they compound.

**RULE B-5: Do not use `$queryRaw` with `::uuid` cast through Supabase PgBouncer.**
**Why:** PgBouncer in transaction mode sends parameters as untyped text. `WHERE id = $1::uuid` fails with `operator does not exist: text = uuid` because the cast is not applied before type resolution. Raw UUID comparisons via `$queryRaw` break silently through the pooler.
**How to apply:** Use Prisma's typed query methods (`updateMany`, `findUnique`) for UUID comparisons. For atomic credit deduction, use `updateMany WHERE id = $id AND credits >= $cost` — the conditional UPDATE is atomic at the row level and handles race conditions correctly without `SELECT ... FOR UPDATE`.

**RULE P-4: The health endpoint is `GET /v1/health`, not `/v1/status`.**
**Why:** The English spec (authoritative) defines `GET /v1/health`. Writing `/v1/status` in code produces a 404 for any monitoring integration or Railway health check configured against `/v1/health`.
**How to apply:** Search for `/v1/status` before every commit — should return zero results.

**RULE D-3: Railway blocks the Supabase direct host port — use Supavisor pooler on port 5432.**
**Why:** The Supabase direct connection host is unreachable from Railway. This is not a credentials problem. The only working connection string uses the Supavisor pooler hostname with port 5432 in session mode.
**How to apply:** When setting `DATABASE_URL` on Railway, use the Supavisor session-mode URL (`?pgbouncer=true` is NOT needed for session mode — that flag is for transaction mode). Verify with `npx prisma db pull` after setting the URL before running any migrations.

**RULE A-5: AI-generated enrichment fields must have a null fallback — they are not correctness requirements.**
**Why:** A Claude timeout or outage must not block the match response. The AI summary is enrichment. A response with `ai_summary: null` is correct; a 503 because Claude timed out is not acceptable when scoring already completed successfully.
**How to apply:** Any AI-generated field in the API response should be typed as `string | null`. The pipeline must proceed to billing and response even when Claude returns null. Only roll back billing if Claude fails AND the failure occurred before the response could be assembled (i.e., scoring itself did not complete).

**RULE D-4: Use in-memory rate limiting only on single-dyno deployments.**
**Why:** In-memory rate limit state is not shared across Railway dyno instances. On a single dyno it's exact. The moment Railway auto-scales to two dynos, each dyno enforces its own 100 req/min limit, effectively doubling the true rate limit.
**How to apply:** In `rateLimiter.ts`, add a comment: `// in-memory store — migrate to Redis before enabling Railway auto-scaling`. Add a pre-scaling checklist item: "upgrade rate limiter to Redis-backed store."

**RULE T-4: Spy on `prisma.model.findMany` to avoid loading 8000+ rows in integration tests.**
**Why:** Tests that call `POST /v1/match` hit the real DB and load all active offers (8000+), making each test take 30+ seconds. With Claude mocked but offers un-mocked, total check time was 241s.
**How to apply:** In `beforeAll`, capture `prisma.offer.findMany.bind(prisma.offer)` as `origFindMany`, then `(vi.spyOn(prisma.offer, 'findMany') as any).mockImplementation(...)`. Return controlled fixtures for the main query, `[]` for skill-excluded (identified by `args?.select?.id`), and `origFindMany(args)` for stretch-offer lookups (identified by `args?.where?.id?.in`). Cast the spy to `any` before `.mockImplementation` — Prisma's `PrismaPromise` return type is incompatible with `async` functions but irrelevant at runtime.

**RULE T-6: When adding a new `prisma.model.findMany` call that uses `select: { id: true }`, update the test spy to pass it through.**
**Why:** The `match.test.ts` spy identifies the skill-excluded query by `args?.select?.id` and returns `[]`. Any new existence-check query that also uses `select: { id: true }` will be silently intercepted and return `[]`, making the FK guard filter out all rows.
**How to apply:** Add `if (args?.where?.id?.in) return origFindMany(args)` as the first branch in the spy, before the `select?.id → []` branch. This distinguishes existence checks (`where.id.in`) from the skill-excluded query (`where.id.notIn`).

**RULE T-5: Tests that verify seenIds deduplication must stay as integration tests.**
**Why:** The `does not re-process` test asserts that `total_offers_scanned` decreases on the second call. With mocked `findMany` that ignores WHERE clauses, both calls return the same fixtures — the assertion fails. Only a real DB query that honours `NOT { id: { in: seenIds } }` gives the correct behaviour.
**How to apply:** Move deduplication tests to `tests/integration/` (excluded from default `vitest run`). Run via `npm run test:integration`.
