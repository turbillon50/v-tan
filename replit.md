# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Project: Money Maker

Crypto algorithmic trading machine — aggressive hunting bot with auto-optimized parameters.

### Design Theme
- **Colors**: Aqua turquoise (#00E5CC) + Emerald green (#00E676) + Deep ocean BG (#020a12)
- **Crystal effect**: Aqua water/crystal aesthetic — conic gradients, inset box-shadow, caustic ripple animation, breathing glow
- **Crystal button**: Floating 64px circle at bottom-center (mobile only), PnL-reactive (winning=emerald, losing=red, neutral=aqua pulse)
- **Icon**: Crystal aqua $ with diamond facets, turquoise-to-emerald gradient, deep ocean background

### Architecture
- **Frontend**: React + Vite + Tailwind at `artifacts/trading-dashboard`
- **Backend**: Express 5 API server at `artifacts/api-server`
- **Shared lib**: Zod schemas + React Query hooks at `lib/api-zod` + `lib/api-client-react`

### Pages (Frontend)
- `/panel` — Unified dashboard: balance, PnL, hybrid engine ON/OFF, regime indicator, capital %, positions, recent trades, stats
- `/historial` — Trade history

### API Routes (Backend)
- `GET /api/bot/status` — Full hybrid engine state (regime, escalera layers, MP pairs, positions, stats)
- `POST /api/bot/toggle` — Start/stop Hybrid Engine (body: `{active, capitalPercent, liveMode}`)
- `GET /api/bot/bybit-positions` — Live Bybit positions
- `PATCH /api/bot/settings` — Update settings without toggling
- `GET /api/bot/tanit-history` — Load full Tanit chat history from DB
- `POST /api/bot/gemini-chat` — Send message to Tanit (persists to DB)

### Tanit AI Commander
- **Personality**: Diosa cartaginesa, compañera real, española mexicana casual/afectuosa — SAGRADA (no cambiar)
- **Memory**: Persistent DB table `tanit_chat` — survives redeploys, loads on every page
- **Primary model**: Gemini 2.5 Flash (`thinkingBudget:0`, `responseMimeType:application/json`, timeout 35s)
- **Multi-AI fallback chain** (cuando Gemini falla):
  1. Gemini mini-retry (mismo modelo, prompt reducido, 20s)
  2. OpenAI GPT-4o-mini via Replit AI Integrations (env: `AI_INTEGRATIONS_OPENAI_BASE_URL/API_KEY`)
  3. Perplexity sonar-pro (env: `PERPLEXITY_API_KEY`) — pagado, máxima disponibilidad
- **Perplexity market intel**: En cada prompt principal, Perplexity busca en tiempo real noticias crypto, movimientos de precio y riesgos macro — se inyecta como `=== 🌐 INTEL DE MERCADO EN TIEMPO REAL ===`
- **Semaphore**: `_cmdInFlight`/`_cmdQueue` — previene llamadas concurrentes a Gemini
- **History**: Últimos 16 mensajes como contexto en cada prompt
- **Proactive**: Analiza mercado, sugiere acciones, ejecuta trades autónomamente

### Dynamic Leverage Engine (trading-engine.ts)
Single unified trading engine with dynamic leverage scaling strategy:
- **Entry**: All positions enter at 5x leverage with $1.20 margin (~$6 notional)
- **Momentum Scaling**: Fast loop (500ms) tracks price momentum and scales leverage 5x→20x
- **Force Close at 20x**: When leverage reaches DYNAMIC_LEV_MAX (20x), position auto-closes for profit
- **Dynamic SL**: Stop loss tightens as leverage increases (4% at 5x → 1% at 20x)
- **Trailing SL**: Moves SL in favor as price moves, protecting gains
- **Max 5 positions**: MAX_CONCURRENT_POSITIONS=5, escalonPositionsTarget=5
- **24 symbols**: BTC, ETH, SOL, LINK, XRP, DOGE, ADA, AVAX, TON, ATOM, TRX, BCH, etc.
- **LEARN**: Adaptive threshold from DB history
- **Momentum Score**: Based on % from entry (weight 100), trend consistency (weight 20), speed (weight 500)
- **Leverage steps**: +1 per tick when momentum ≥ 1.5, hold when 0-1.5, -1 when < -0.3

### Hedge Mode (Bybit Both-Side)
- **Activación**: Al arrancar el motor llama `switchPositionMode("", 3)` — Both-Side en toda la cuenta
- **Abrir hedge**: Fast loop (500ms) detecta `leverage ≥ 15x + momentum < -1.2 + pnlMargen < -15%` → abre posición opuesta con 50% del tamaño principal
- **Cerrar hedge**: Se cierra automáticamente cuando `momentum > 0.6` (recuperación) o a los 30 minutos
- **Estado en EscaleraSymState**: `hedgeActive`, `hedgeDirection`, `hedgeQty`, `hedgeEntryPrice`, `hedgeOpenedAt`
- **Alertas Telegram**: Notifica activación (🔀 HEDGE ACTIVADO) y cierre (🔀 HEDGE CERRADO)
- **positionIdx**: 1=LONG, 2=SHORT — ya usado en todas las órdenes

### Calibration (DO NOT CHANGE without user request)
- Dynamic leverage: 5x entry → 20x max (force close)
- Margin per position: $1.20
- Capital: 100%
- Live balance: ~$15.85

### API Keys
- `BYBIT_API_KEY` + `BYBIT_API_SECRET` — Bybit mainnet (UID 555753345)
- `GEMINI_API_KEY` — AI analysis
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — trade alerts
