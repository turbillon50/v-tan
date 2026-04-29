# MONEYMAKER Stabilization Plan

## Rescue Objective

Stabilize deployment and runtime while preserving Tanit identity, memory continuity, chat history, and trading history intact.

This plan is intentionally non-destructive-first.

## What Is Broken (Confirmed or Highly Likely)

1. `signal_outcomes` query mismatch in `/api/bot/signals/db`:
   - Query uses `recorded_at`; persistence/schema uses `created_at`.

2. Auth architecture drift:
   - Clerk proxy/middleware exists but is not mounted in `app.ts`.
   - Session auth route (`/auth/status`) currently reports authenticated regardless of session.

3. Health route inconsistency:
   - Runtime endpoint is `/healthz`; docs mention `/health`.

4. Frontend build portability blocker:
   - `vite.config.ts` throws if `PORT` is unset, which is risky for Vercel build.

5. Partial schema visibility:
   - Critical operational tables are raw-SQL managed and absent from Drizzle schema files.

6. Unsafe destructive endpoint exposed:
   - `/api/bot/trades/clear` can erase trade history and learning outcomes.

7. Environment/tooling fragility:
   - Build/typecheck not runnable in current host due missing `pnpm`.

## What Is Risky

- Any DB migration driven only by Drizzle schema may omit raw-SQL operational tables.
- Any cleanup pass that removes "unused" Tanit tables/endpoints can silently break memory continuity.
- Any auth refactor done without compatibility mode can lock out control surfaces or expose them unintentionally.
- Any routing changes to bot endpoints can break dashboard + Telegram control flow.

## What Must Be Fixed First

1. Read-only DB inventory + parity verification
   - Capture exact live table list, row counts, and critical table checksums.
   - Explicitly compare source DB and target DB before cutover.

2. Non-destructive runtime fixes
   - Fix `recorded_at` query bug.
   - Add compatibility health route or align deployment probes.
   - Remove frontend `PORT` hard-fail for build-time stability.

3. Auth stabilization decision
   - Choose one active auth model for migration phase (temporary permissive internal mode vs fully wired Clerk).
   - Preserve current operational access until replacement is verified.

4. Guardrail destructive endpoints
   - Feature-flag or admin-lock risky data-deletion endpoints during rescue.

5. Deployment split stabilization
   - Verify backend, frontend, and proxy can deploy independently with stable env mappings.

## What Must Never Be Touched

- Existing DB contents in memory/trading continuity tables.
- Tanit chat/memory/evolution prompts and persistence paths.
- Historical trade records and signal outcomes.
- Personality/identity seeding logic semantics (unless explicit approval and rollback strategy).

## Safest Recovery Order (Exact Sequence)

1. Freeze and snapshot (no code mutation yet)
   - DB snapshot/backup at provider level.
   - Export row counts for:
     - `tanit_chat`, `tanit_memory`, `tanit_runtime_config`, `tanit_evolutions`, `tanit_trade_context`
     - `trades`, `signal_outcomes`, `swap_history`, `sessions`, `bot_state`, `tanit_suggestions`

2. Produce environment matrix
   - Canonical `.env` contract for local, Vercel, Railway, and external DB.
   - Explicitly map required vs optional vars.

3. Apply minimal non-destructive bug fixes
   - SQL column mismatch fix.
   - Health endpoint compatibility.
   - Frontend build config portability (`PORT` handling).
   - Keep logic and DB schema unchanged.

4. Add safety controls
   - Disable destructive endpoints by default in production rescue mode (without deleting code).
   - Add explicit runtime warning banners for dangerous operations.

5. Stabilize auth path
   - Implement a temporary consistent auth mode for migration window.
   - Keep behavior equivalent for existing operator workflows.

6. Validate end-to-end flows in staging
   - `/api/bot/status`
   - `/api/bot/tanit-history`
   - `/api/bot/gemini-chat`
   - Telegram incoming/outgoing
   - Bybit read-only diagnostics + controlled dry-run order path

7. Controlled production cutover
   - Frontend to Vercel
   - API server and proxy to stable hosts
   - External DB as source-of-truth clone
   - Post-cutover parity verification (same critical table counts + smoke tests)

8. Post-cutover hardening (only after continuity proven)
   - Optional auth modernization
   - Optional schema unification (Drizzle + raw SQL reconciliation)
   - Optional Replit dependency cleanup

## What Can Be Improved Later (Safe Deferred)

- Unify raw SQL tables into versioned migration system.
- Consolidate duplicated Telegram mechanisms (polling + webhook) if desired.
- Mount and formalize `routes/ai.ts` if still needed.
- Improve observability (structured health checks and migration diagnostics endpoints).

## What Should Be Removed Later (Only If Safe)

- Replit-only dev plugins/configs not needed outside Replit:
  - `@replit/vite-plugin-*`
  - `.replit`-specific assumptions in frontend/build path
- Dead/unused auth paths after final auth model is selected.
- Redundant route surfaces that duplicate privileged operations.

Removal rule: only after proving no impact to Tanit memory continuity and live control flows.

## Approval Gate Before Any Destructive Change

No destructive operation should be executed unless all are true:
- Explicit written approval
- Verified fresh backup
- Rollback plan tested
- Targeted scope documented
- Post-change integrity checks defined

