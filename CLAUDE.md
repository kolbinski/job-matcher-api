# JobMatcher API — Session Orchestrator

Last reviewed: 2026-06-03

## Session Start Protocol

Read these files in order before beginning any work:

1. `PERSONA.md` — adopt expert identity, load SPARK methodology
2. `memory.md` — load architectural decisions and project knowledge
3. `current-task.md` — load active work state and next action
4. `lessons.md` — apply all prevention rules before writing any code

**This file is a router, not a persona.** All expert identity lives in `PERSONA.md`.

---

## Project Identity

**Product:** JobMatcher API — REST API that matches candidate profiles (JSON) against live job board listings using AI-powered scoring, red flag filtering, and missing skills detection.

**Business model:** Pay-per-use, $0.10/call. Price stored in `settings.call_cost` — never hardcode it.

**Stack:** Node.js + TypeScript + Express + PostgreSQL (Supabase) + Prisma + Zod + Claude API (claude-sonnet) + Stripe + Apify + Railway

**Deployment target:** Railway (Node.js service, pay-as-you-go)

---

## Non-Negotiable Constraints

### Security
- API keys (`jm_live_*`, `jm_test_*`) must NEVER appear in logs, error messages, or DB records
- All endpoints HTTPS only
- Rate limit: 100 calls/minute per API key

### Billing correctness
- Credit deduction (`UPDATE users SET credits = credits - cost`) and `api_calls` INSERT must execute in the **same Prisma transaction** — no partial billing
- `jm_test_*` keys: skip credit deduction, return mock data, still log the call with `cost = 0`
- `call_cost` always read from `settings` table — never from env vars or hardcoded constants

### API versioning
- All endpoints under `/v1/` prefix
- Breaking changes → new `/v2/` route; `/v1/` maintained for minimum 6 months
- Clients notified by email on deprecation

### TypeScript
- `strict: true` in tsconfig — no `any`, no implicit `any`, no non-null assertions without comment
- All monetary values: `Decimal` (Prisma) in DB, `number` rounded to 4dp in business logic

---

## Workflow Rules

### Before writing code
1. Check `current-task.md` for active work state
2. Identify which SPARK step (from `PERSONA.md`) this work belongs to
3. State which OV checkpoints the change must satisfy before it's complete

### Code standards
- Zod schemas at all API boundaries (request body, query params, env vars)
- Prisma for all DB access — no raw SQL except migration files
- `express-async-errors` or explicit try/catch — no unhandled promise rejections
- Error responses follow the standard error table from the spec: `401 INVALID_API_KEY`, `402 INSUFFICIENT_CREDITS`, `422 INVALID_PROFILE`, `429 RATE_LIMIT_EXCEEDED`, `500 INTERNAL_ERROR`

### Test standards
- Vitest for all tests
- Integration tests hitting a real Supabase test schema preferred over unit mocks
- Credit deduction tests must cover: success, rollback on Claude API failure, `jm_test_` key bypass

### Scoring algorithm weights (immutable in V1)
```
techScore    * 0.40
salaryScore  * 0.25
remoteScore  * 0.20
industryScore* 0.15
```
Sum = 1.00. Any change to weights is a breaking change tracked in `memory.md`.

---

## Git Workflow

When the user says **"commit"**: run `git add -A && git commit -m "..." && git push origin main`. Always push to `main` — never to `master` or any other branch.

---

## Session End Protocol

Update in this order — never skip:

1. **`current-task.md`** — mark completed steps, update status, set next action
2. **`memory.md`** — append any new architectural decisions, gotchas, or schema changes
3. **`lessons.md`** — append prevention rules for any mistake made this session

---

## File Ownership Map

| File | Contains | Does NOT contain |
|------|----------|-----------------|
| `CLAUDE.md` | Orchestration rules, constraints, workflow | Persona identity, methodology steps |
| `PERSONA.md` | Expert identity, SPARK steps, CoV, FAP, OV | Session state, task tracking |
| `current-task.md` | Active build state, plan, next action | Completed history, architecture |
| `memory.md` | Architectural decisions, gotchas, schema facts | Active task state, persona |
| `lessons.md` | Prevention rules (mistake → rule) | Design decisions, task state |
