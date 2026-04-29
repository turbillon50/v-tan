# MONEYMAKER Memory Report

## Rescue Scope and Non-Negotiables

This is a rescue/migration assessment, not a rebuild plan.

Hard constraints preserved in this report:
- Do not reset/overwrite DB
- Do not truncate memory/chat continuity
- Do not remove personality/prompt systems
- Do not break trading history
- Do not perform destructive schema edits without explicit approval

## Database URL vs OLD_DATABASE_URL

- `DATABASE_URL` is required and actively used by `lib/db/src/index.ts` and `lib/db/drizzle.config.ts`.
- `OLD_DATABASE_URL` is **not referenced anywhere in the repository**.
- Risk: there is no built-in dual-read/dual-compare mechanism between old/new databases in code.
- Rescue implication: before migration, explicit external verification is required (DB-level table counts + checksum sampling), because app code currently assumes a single source DB.

## Observed Database Structures

### Current typed schema (`lib/db/src/schema/*`)

Declared Drizzle tables:
- `bot_state`
- `trades`
- `swap_history`
- `signal_outcomes`
- `tanit_memory`
- `tanit_chat`
- `conversations`
- `messages`

### Runtime-created legacy/operational tables (raw SQL in server libs)

Created/used directly in `artifacts/api-server/src/lib/db-persistence.ts` and `trading-engine.ts`:
- `sessions`
- `tanit_runtime_config`
- `tanit_evolutions`
- `tanit_trade_context`
- `tanit_suggestions`

Important: these are part of production behavior but are not represented in Drizzle schema files.

## Memory and Continuity Persistence (Where Tanit "lives")

Primary continuity stores:
- `tanit_chat`: persistent chat history used by `/api/bot/tanit-history` and Gemini command flow.
- `tanit_memory`: identity/personality memory records, including identity seeding logic in `trading-engine.ts`.
- `tanit_runtime_config`: adaptive runtime personality/strategy parameter memory.
- `tanit_evolutions`: historical evolution log.
- `tanit_trade_context`: causal memory per trade for reflective/adaptive logic.

Secondary continuity stores:
- `bot_state`: persisted live engine state and recovery state.
- `trades`, `signal_outcomes`, `swap_history`, `sessions`: historical behavioral/trading memory.

## Trading Logs and Historical Integrity

Core historical logs:
- `trades`: open/closed outcomes
- `signal_outcomes`: learning outcomes
- `swap_history`: swap outcome memory
- `sessions`: session stats
- `bot_state`: active runtime snapshot

High-risk endpoint discovered:
- `POST /api/bot/trades/clear` performs hard deletions from `trades` and `signal_outcomes`.
- In rescue mode this endpoint must be treated as dangerous and blocked by policy/guardrail (without deleting existing code).

## Critical Failure Points Found

1. Query/schema mismatch:
   - `/api/bot/signals/db` selects `recorded_at` from `signal_outcomes`, but schema and insert logic use `created_at`.
   - Likely runtime SQL error when endpoint is hit.

2. Auth stack drift:
   - `clerkProxyMiddleware.ts` exists, but current `app.ts` does not mount Clerk proxy/middleware.
   - `auth.ts` currently returns authenticated status regardless of session in `/auth/status`.
   - Creates inconsistent security model and false auth state.

3. Health endpoint mismatch:
   - Runtime health route is `/healthz`, while architecture docs mention `/health`.
   - Can break health checks depending on deployment config.

4. Frontend build portability issue:
   - `trading-dashboard/vite.config.ts` hard-fails if `PORT` env is absent.
   - Vercel build environments usually do not require/provide `PORT` at build step.

5. DB model split risk:
   - A portion of critical DB tables exists only in raw SQL logic, not in typed schema.
   - Migration tooling that relies only on Drizzle schema will miss operational tables.

## Pruning/Retention Risk (Memory Preservation)

Automatic pruning functions exist:
- `pruneSignalOutcomes`
- `pruneTanitTradeContext`
- `pruneTanitEvolutions`
- `pruneSwapHistory`

These are non-destructive to core identity/chat but still delete historical data by age/cap.
In rescue mode, retention policy must be frozen/reviewed before production migration cutover.

## Missing/Fragile Dependencies and Environment

Observed runtime/env fragility:
- Local environment in this audit cannot execute `pnpm` (`pnpm` command missing), blocking direct typecheck/build validation.
- Multiple optional API integrations imply partial-degraded modes if keys are missing.

## Required Server Environment Variables (Observed in code)

Core:
- `DATABASE_URL`
- `PORT`
- `SESSION_SECRET`

Bybit:
- `BYBIT_API_KEY`
- `BYBIT_API_SECRET`
- `BYBIT_PROXY_URL` (optional but used)
- `PROXY_SECRET` (with proxy)

AI:
- `GEMINI_API_KEY`
- `PERPLEXITY_API_KEY`
- `AI_INTEGRATIONS_GEMINI_BASE_URL`
- `AI_INTEGRATIONS_GEMINI_API_KEY`
- `AI_INTEGRATIONS_OPENAI_BASE_URL`
- `AI_INTEGRATIONS_OPENAI_API_KEY`

Telegram:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_RATE_LIMIT_PER_MIN`
- `TELEGRAM_ALLOWED_USER_IDS`

Auth/other:
- `CLERK_SECRET_KEY` (currently not actively wired in app middleware path)
- `APP_PASSWORD`
- `CRYPTOCOMPARE_API_KEY`
- `CRYPTOPANIC_API_KEY`
- `LOG_LEVEL`
- `NODE_ENV`

## What Must Never Be Touched (Rescue Guardrails)

- Existing DB records for:
  - `tanit_chat`, `tanit_memory`, `tanit_runtime_config`, `tanit_evolutions`, `tanit_trade_context`
  - `trades`, `signal_outcomes`, `swap_history`, `sessions`, `bot_state`
- Tanit persona/system prompts and response flow (`runGeminiUserCommand` chain)
- Historical trade and chat continuity
- Any destructive DB endpoint execution during rescue

## Immediate Priority Fixes (Non-Destructive)

1. Fix SQL/query mismatch (`recorded_at` -> `created_at`) without altering data.
2. Normalize health check route expectations.
3. Stabilize auth path (decide and wire one model cleanly, preserving current access behavior intentionally during transition).
4. Remove build portability blockers for Vercel (especially hard `PORT` requirement in frontend build config).
5. Introduce explicit migration verification script/reporting for old/new DB parity before any cutover.

