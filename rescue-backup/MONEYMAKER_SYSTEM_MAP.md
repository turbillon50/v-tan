# MONEYMAKER System Map

## High-Level Architecture

Monorepo (pnpm workspace):
- Backend API: `artifacts/api-server` (Express)
- Frontend dashboard: `artifacts/trading-dashboard` (React + Vite + Wouter)
- DB package: `lib/db` (PostgreSQL pool + Drizzle schema exports)
- API typing/codegen libs: `lib/api-zod`, `lib/api-client-react`
- External Bybit signing proxy: `proxy` (separate deployable service)

## Entry Points

Backend:
- `artifacts/api-server/src/index.ts` (server start, telegram command init, startup alerts)
- `artifacts/api-server/src/app.ts` (Express middleware + route mount)

Frontend:
- `artifacts/trading-dashboard/src/main.tsx`
- `artifacts/trading-dashboard/src/App.tsx`

Proxy:
- `proxy/index.js` (Bybit HMAC proxy service)

## Backend Route Map (`/api/*`)

Mounted in `artifacts/api-server/src/routes/index.ts`:
- `health.ts` -> `/healthz`
- `auth.ts` -> `/auth/*`
- `market.ts` -> `/market/*`
- `indicators.ts` -> `/indicators/*`
- `signals.ts` -> `/signals/*`
- `portfolio.ts` -> `/portfolio/*`
- `orders.ts` -> `/orders/*`
- `bot.ts` -> `/bot/*` (core control + Tanit memory/chat endpoints)
- `capital.ts`, `backtest.ts`, `news.ts`, `alerts.ts`
- `bybit-real.ts` -> `/bybit/*`

Note: `routes/ai.ts` exists but is not mounted in router index currently.

## Frontend Flow

`App.tsx` routes:
- `/panel`, `/dashboard`, `/bot`, `/capital`, `/curva`, `/backtest`, `/alertas`, `/furtivo`, `/manual`, `/historial`, `/live`

Current auth state:
- No active Clerk provider usage in current frontend `App.tsx`.
- Dashboard flow appears effectively open (redirect to `/panel`).

API base resolution:
- `VITE_API_URL` if provided
- fallback to `BASE_URL` root path

## Database Flow

Connection:
- `lib/db/src/index.ts` uses `DATABASE_URL` via `pg` pool (`ssl: rejectUnauthorized: false`).

Persistence styles:
1. Typed schema via Drizzle (`lib/db/src/schema/*`)
2. Raw SQL operational persistence in backend libs (`db-persistence.ts`, `trading-engine.ts`)

Core persistence path:
- Engine state save/load -> `bot_state`
- Trade open/close -> `trades`
- Learning outcomes -> `signal_outcomes`
- Tanit memory/chat/evolution/runtime config/context -> dedicated Tanit tables

## Telegram Communication Flow

Outgoing:
- `lib/telegram.ts` -> Telegram Bot API `sendMessage`

Incoming commands/chat:
- `index.ts` calls `initTelegramCommands()`
- `telegram-commands.ts` registers command handler
- `telegram.ts` long-polls Telegram `getUpdates` every 4s
- Message accepted only if `chat_id` and optionally `user_id` match allowlist
- Free-text messages route into `runGeminiUserCommand` (Tanit conversational layer)

Separate webhook-based alert subsystem:
- `routes/alerts.ts` supports webhook and auto-fix webhook endpoints

## Bybit Execution Flow

Core client:
- `lib/bybit-auth.ts`
- Supports direct signed calls or external proxy mode (`BYBIT_PROXY_URL` + `PROXY_SECRET`)

Execution sequence:
- Signal/engine decides -> qty/leverage -> `placeMarketOrder`
- Position mgmt -> `setTradingStop`, `closePosition*`, `getOpenPositions`
- Account diagnostics -> `/api/bybit/*` and `/api/bot/*` diagnostics endpoints

Engine integration:
- `trading-engine.ts` and `hybrid-engine.ts` orchestrate execution loops and state sync.

## AI Dependency Map

Primary:
- Gemini (`GEMINI_API_KEY`) for sentiment and Tanit command reasoning

Fallback/augmented:
- OpenAI via integrations gateway (`AI_INTEGRATIONS_OPENAI_*`)
- Gemini via integrations gateway (`AI_INTEGRATIONS_GEMINI_*`)
- Perplexity (`PERPLEXITY_API_KEY`) for real-time market/news intel

Additional AI route:
- `routes/ai.ts` conversation system using `@workspace/integrations-gemini-ai` + DB tables (`conversations`, `messages`)

## Auth Dependency Map

Present but inconsistent components:
- `@clerk/express` and Clerk proxy middleware file exist
- Clerk proxy path defined as `/api/__clerk`
- Frontend currently does not actively wrap routes in Clerk provider
- `auth.ts` uses session + app password path and returns always-authenticated status in `/auth/status`

Conclusion:
- Clerk is currently optional/partially disconnected rather than a coherent active dependency.

## Deployment/Runtime Dependency Map

Current artifacts:
- Replit metadata/config: `.replit`, `.replit-artifact`
- Vite plugins from `@replit/*` in frontend config/package
- Railway configs: `railway.json` (API server), `proxy/railway.json` (Bybit proxy)
- Vercel config for frontend static output: `vercel.json`

Migration impact:
- Replit-specific plugins/configs are embedded but mostly dev-oriented; must be decoupled safely, not removed blindly.

