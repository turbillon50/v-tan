# Tanit — Arquitectura del Sistema
> Documento de navegación para revisión en Cursor Pro
> Monorepo: `pnpm` workspaces · Node 20 · TypeScript · PostgreSQL

---

## Estructura del monorepo

```
/
├── artifacts/
│   ├── api-server/          ← Backend Express (puerto 8080 en dev)
│   │   └── src/
│   │       ├── app.ts           ← Entry point Express + middleware stack
│   │       ├── index.ts         ← Arranque del server, engineReadyPromise
│   │       ├── routes/          ← Endpoints REST (ver sección abajo)
│   │       ├── lib/             ← Núcleo del sistema (ver sección abajo)
│   │       └── middlewares/
│   │           └── clerkProxyMiddleware.ts  ← Proxy HTTPS a Clerk FAPI
│   │
│   └── trading-dashboard/   ← Frontend React + Vite (Wouter routing)
│       └── src/
│           ├── App.tsx          ← ClerkProvider + rutas protegidas
│           ├── pages/           ← Páginas del dashboard
│           └── components/      ← Componentes UI
│
├── packages/
│   └── db/                  ← Pool PostgreSQL compartido (@workspace/db)
│
└── .local/
    └── skills/              ← Skills del agente (no tocar)
```

---

## API Server — Middleware stack (`app.ts`)

```
pinoHttp (logging)
  → clerkProxyMiddleware  en /clerk-proxy/**  ← DEBE ir antes de body parsers
  → cors
  → express.json / urlencoded
  → cookieParser
  → express-session
  → clerkMiddleware()      ← inyecta req.auth en cada request
  → /api router
```

**Regla crítica:** `clerkProxyMiddleware` trabaja con el stream crudo de bytes.
Moverlo después de `express.json` rompe el proxy.

---

## API Server — Routes (`src/routes/`)

| Archivo          | Prefijo   | Descripción                                      |
|------------------|-----------|--------------------------------------------------|
| `index.ts`       | `/api`    | Router raíz, monta todos los sub-routers         |
| `health.ts`      | -         | GET /health                                      |
| `auth.ts`        | -         | Sesión / Clerk auth                              |
| `bot.ts`         | `/bot`    | **Todo el control de Tanit** (ver abajo)         |
| `market.ts`      | -         | Datos de mercado                                 |
| `indicators.ts`  | -         | Indicadores técnicos                             |
| `signals.ts`     | -         | Señales históricas                               |
| `portfolio.ts`   | -         | Portafolio                                       |
| `orders.ts`      | -         | Órdenes manuales                                 |
| `capital.ts`     | -         | Gestión de capital                               |
| `backtest.ts`    | -         | Backtesting                                      |
| `news.ts`        | -         | Feed de noticias                                 |
| `alerts.ts`      | -         | Alertas                                          |
| `bybit-real.ts`  | `/bybit`  | Operaciones directas Bybit REST                  |
| `furtivo.ts`     | -         | Modo furtivo                                     |

### Endpoints clave de `/api/bot` (`routes/bot.ts` ~970 líneas)

```
GET  /bot/status                   ← Estado completo del motor
GET  /bot/bybit-positions          ← Posiciones abiertas en Bybit
GET  /bot/balance-history          ← Historial de balance
GET  /bot/trades/db                ← Trades cerrados (filtros: page, limit, symbol)
GET  /bot/analysis                 ← Stats de aprendizaje
GET  /bot/analysis/sl-regret       ← Cuántos SL hubieran ganado esperando
GET  /bot/signals/db               ← Señales con outcome
GET  /bot/whalepattern             ← Mapa de patrones 24h
GET  /bot/timepattern?hour=N       ← Patrón de una hora específica
GET  /bot/market-analysis          ← Análisis de mercado actual
GET  /bot/intelligence             ← Inteligencia acumulada de Tanit
GET  /bot/tanit-history            ← Historial de chat con Tanit
GET  /bot/suggestions              ← Sugerencias autónomas de Tanit
GET  /bot/preflight                ← Verificar conectividad antes de ir en real
GET  /bot/wallets                  ← Saldos de todas las cuentas Bybit
GET  /bot/btc-balance              ← Saldo BTC en todas las cuentas
GET  /bot/swaps                    ← Historial de swap de posiciones
GET  /bot/scale-in-events          ← Eventos de scale-in
GET  /bot/tg-audit                 ← Audit log Telegram

POST /bot/toggle                   ← Start/stop del motor
POST /bot/close/:symbol            ← Cerrar posición por símbolo
POST /bot/close-bybit/:symbol      ← Cerrar en Bybit directamente
POST /bot/close-all-bybit          ← Cerrar todas las posiciones
POST /bot/kill                     ← KILL SWITCH — emergencia
POST /bot/reset                    ← Reset del motor
POST /bot/reset-session-multipliers
POST /bot/testnet                  ← Cambiar entre mainnet/testnet
POST /bot/configure-small-account
POST /bot/middlepoint/start
POST /bot/middlepoint/stop
POST /bot/mp/force
POST /bot/ic                       ← Compound Cycle
POST /bot/ic/force
POST /bot/transfer-to-fund
POST /bot/transfer-to-futures
POST /bot/convert-btc
POST /bot/trades/clear             ← Borrar historial de trades

PATCH /bot/settings                ← Configurar parámetros del bot
PATCH /bot/daily-limit             ← Límite de pérdida diaria
PATCH /bot/mp/:symbol/levels
PATCH /bot/set-session-multiplier
PATCH /bot/suggestions/:id

DELETE /bot/tg-audit
DELETE /bot/suggestions/:id
```

---

## Núcleo del motor (`lib/`)

### `trading-engine.ts` — 11 908 líneas

El archivo más crítico del sistema. Tanit vive aquí.

#### Mapa de secciones (por número de línea)

| Líneas      | Sección                                               |
|-------------|-------------------------------------------------------|
| 1–40        | Imports                                               |
| 40–100      | Variables globales: state, flags, timers              |
| 55–102      | `buildStateData()` / `saveState()` / `saveStateImmediate()` |
| 104–171     | `cleanStaleOpenTrades()` — reconcilia DB con Bybit al arrancar |
| **173–307** | **`loadState()`** — restauración de estado + sync Bybit |
| 309–370     | `_scheduleHistoryPruner()` — limpieza de datos históricos |
| 372–550     | Helpers de formato (precios, qty, etc.)               |
| **551–696** | **TANIT VIVA** — mood, alertas proactivas, daily summary, reflejos de trade |
| 697–820     | Umbrales de sesión, multiplicadores, `getSessionMultiplier()` |
| 758–805     | `refreshLearningStats()` / `formatLearningStatsForTanit()` |
| 806–850     | `enrichSignalScore()` — noticias + patrones + calibración |
| 854–960     | Cooldown por símbolo, daily loss limit, `checkDailyLimit()` |
| **900–931** | **`emergencyKill()`** — kill switch: cierra todo en Bybit |
| 932–960     | `runPositionMonitor()` / `startPositionMonitor()`     |
| **982–1033**| **`calcMomentumScore()`** — score de momentum activo (CRÍTICO) |
| 1022–1040   | `calcTargetLeverage()` / `calcDynamicSlPct()`         |
| 1041–1060   | `calcLockInSL()` — trailing SL inteligente            |
| **1061–1490**| **`runSlTpFastLoop()`** — loop de monitoreo SL/TP cada 2s (CRÍTICO) |
| 1491–1555   | `startSlTpFastLoop()` / `stopSlTpFastLoop()`          |
| 1556–1685   | Razonamiento causal (TanitReasoning), historial de REJECT |
| **1588–1681**| **`seedTanitIdentity()`** — identidad de Tanit en DB (UPSERT) |
| 1682–1815   | `runRejectIntrospection()` — análisis autónomo de rechazos |
| **1733–1890**| **`loadAndApplyTanitConfig()`** / `applyTanitConfig()` — parámetros dinámicos |
| 1826–1890   | `resetSessionMultipliers()` / `tanitApplyEvolution()` |
| **1891–2152**| **Parámetros de estrategia dinámica** — mutables en tiempo real |
| 2153–2240   | AI Position Evaluator                                 |
| **2241–2474**| **`escaleraOpenLayer()`** — apertura de capas escalera (CRÍTICO) |
| 2475–2633   | `escaleraCloseLayer()` — cierre de una capa           |
| **2634–3086**| **`escaleraV2ScanSymbol()`** — lógica completa de escaneo por símbolo |
| 3087–3127   | `countOpenPositions()` / `canSymbolTradeCapa1()`       |
| 3127–3297   | **Position Swap** — `findWeakestPositionForSwap()` / `tryPositionSwap()` |
| **3298–3400**| **`escaleraV2Scan()`** — loop principal sobre todos los símbolos |
| 3400–3478   | `pearsonCorrelation()` / `updateCorrelationMatrix()`  |
| 3479–3540   | `simCalcQty()`, `getPrice()`, indicadores técnicos base |
| **3538–3620**| **`fetchGeminiSentiment()`** — llamada a Gemini AI para sentimiento |
| **3621–3675**| **GEMINI COMMANDER** — cerebro central interactivo    |
| 3676–3735   | Funciones de historial de trades + DB                 |
| 3720–3790   | Schema migration idempotente para trade_history       |
| 3764–3800   | Stats multidimensionales — buckets de sesión/funding/ATR |

> ⚠️ Las secciones entre ~3800–11908 contienen: `startEngine()`, `stopEngine()`,
> Middle Point engine, lógica de Gemini Commander (chat), manejo de Telegram commands,
> y todas las funciones exportadas del módulo.

#### Variables de estado principales

```typescript
state = {
  simBalance,        // Balance USDT (sincronizado con Bybit real)
  liveBalance,       // Equity real de Bybit
  liveAvailable,     // Disponible real de Bybit
  mode,              // "escalon" | "conservative" | "aggressive" | ...
  active,            // ¿Motor corriendo?
  liveMode,          // true = opera en Bybit real, false = simulado
  capitalPct,        // % de capital a usar
  inceptionCapital,  // Capital del día 1 (nunca se modifica)
  tradeLog[],        // Historial de trades en memoria
  tradesExecuted,
  sessionPnl,
  totalFees,
  balanceHistory[],
}

// Fuera del objeto state:
_userStopped        // El usuario detuvo el bot (no auto-relanzar)
_tradingPaused      // Pausado vía Telegram
escalonPositionsTarget  // Max posiciones simultáneas (modo escalera)
calibrationHistory[]    // Últimos 5 ciclos de aprendizaje autónomo
```

#### Constitución inmutable de Tanit (NO modificar sin consenso)

```
1. Stop Loss mínimo = 1.5 × ATR14 SIEMPRE — sin excepción
2. Hedge = protección activa, nunca escape de pérdida
3. Kill switch protegido: no cierra si cuenta vacía (equity < $0.50)
4. loadState: restaura si wasActive=true, aunque simBalance=0
5. Sync inicial Bybit: ignora balance microscópico (equity < $0.50)
6. pctFromEntry < 0.0003 NO corto-circuita calcMomentumScore
```

---

### `bybit-ws.ts` — 286 líneas

WebSocket a `wss://stream.bybit.com/v5/public/linear`.

| Función               | Descripción                                                  |
|-----------------------|--------------------------------------------------------------|
| `startBybitWs(syms)`  | Suscribe a tickers + kline.5 + kline.1 para los símbolos dados |
| `stopBybitWs()`       | Cierra WS limpiamente con error sink async (no unhandled rejection) |
| `getWsPrice(sym)`     | Precio live del cache WS                                     |
| `getWsFundingRate(sym)`| Funding rate live                                           |
| `detectWsCascade(sym)`| Detecta cascada de liquidación: vol>3x + mov>1.5% en vela 5m |
| `isWsConnected()`     | true si el WS está activo                                    |

**Cache interno:** `priceCache`, `fundingRateCache`, `lastCandle1m`, `klineBuffer` (60 velas 5m por símbolo)

---

### `db-persistence.ts` — 898 líneas

Capa de acceso a PostgreSQL. Usa `@workspace/db` (pool Neon/pg).

#### Tablas gestionadas

| Tabla                  | Función en código                                      |
|------------------------|--------------------------------------------------------|
| `bot_state`            | `saveStateToDB / loadStateFromDB` — estado único (key='main') |
| `trades`               | `saveOpenTradeToDB / closeTradeInDB` — trades activos  |
| `signal_outcomes`      | `saveSignalOutcome` — outcomes para aprendizaje        |
| `sessions`             | `saveSessionToDB`                                      |
| `tanit_runtime_config` | `saveTanitRuntimeConfig / loadTanitRuntimeConfig`      |
| `tanit_evolutions`     | `saveTanitEvolution / loadTanitEvolutions`             |
| `tanit_trade_context`  | `saveTradeContext / closeTradeContext`                  |
| `swap_events`          | `saveSwapEventToDB / loadSwapHistoryFromDB`            |

**Números de producción actuales:**
- Trades en DB: 286
- Chat messages: 590
- Memorias: 1312
- Evoluciones: 57
- Modo: `escalon` · liveMode: `true`

---

### `bybit-auth.ts`

REST client para Bybit API v5. Firma HMAC-SHA256 de requests.

Funciones principales:
- `placeMarketOrder` / `closePosition` / `closePositionMainnet`
- `setLeverage` / `switchPositionMode` / `setTradingStop`
- `getBybitBalance` — devuelve `{ equity, available }` del UNIFIED account
- `getOpenPositions` — posiciones abiertas en Bybit
- `getRecentExecution` — últimas ejecuciones para reconciliar PnL
- `calcQtyReal` — calcula qty teniendo en cuenta min order size de Bybit
- `invalidateBalanceCache` — fuerza re-fetch de balance
- `getRateLimitStats` — stats del rate limiter interno

---

### `signal-calibrator.ts`

Calibración autónoma de umbrales de señal. Analiza outcomes históricos
y ajusta `SESSION_THRESHOLDS` dinámicamente.

---

### `pattern-detector.ts`

Detecta patrones técnicos en las velas WS (head & shoulders, flags, etc.)
Usa el buffer `klineBuffer` de 5m del WS, no hace llamadas REST.

---

### `news-feed.ts`

Feed de noticias vía Perplexity API. Devuelve resumen y score de sentimiento
para el símbolo en el contexto del prompt de Gemini.

---

### `econ-calendar.ts`

Calendario económico. `isInDangerZone()` devuelve true si hay evento de alto
impacto en la próxima hora — el motor reduce agresividad o pausa.

---

### `telegram.ts` + `telegram-commands.ts`

- `sendTelegram(msg)` — envía mensaje al chat configurado
- `fmtTgTrade(trade)` — formatea trade para Telegram
- `queueParamChange(params)` — encola cambio de parámetro para notificar
- `telegram-commands.ts` — parser de comandos `/start`, `/stop`, `/status`, etc.

---

### `demo-data.ts`

- `RISK_PROFILES` — mapa de perfiles de riesgo (conservative, aggressive, escalon, etc.)
- `calcADX(highs, lows, closes, period)` — ADX técnico
- `calcVWAP(data)` — VWAP

---

## Frontend — Trading Dashboard (`src/`)

### `App.tsx` — Estructura de rutas

```
App
└── SplashScreen (animación inicial, skip con ?nosplash)
└── ThemeProvider
    └── WouterRouter (base = import.meta.env.BASE_URL)
        └── ClerkProvider
            ├── /              → HomeRoute (redirige a /panel o /sign-in)
            ├── /sign-in/*?    → SignInPage (Clerk, tema oscuro custom)
            ├── /sign-up/*?    → SignUpPage
            ├── /panel         → ProtectedRoute → Simple    (panel principal)
            ├── /dashboard     → ProtectedRoute → Dashboard
            ├── /bot           → ProtectedRoute → Bot
            ├── /capital       → ProtectedRoute → Capital
            ├── /curva         → ProtectedRoute → Curve
            ├── /backtest      → ProtectedRoute → Backtest
            ├── /alertas       → ProtectedRoute → Alertas
            ├── /furtivo       → ProtectedRoute → Furtivo
            ├── /manual        → ProtectedRoute → Manual
            ├── /historial     → ProtectedRoute → Historial
            └── /live          → ProtectedRoute → Live
```

### Variables de entorno del frontend

```
VITE_CLERK_PUBLISHABLE_KEY   ← clave pública de Clerk
VITE_CLERK_PROXY_URL         ← URL del proxy Clerk (apunta al api-server)
BASE_URL                     ← base path del asset (vite)
```

### Tema Clerk (colores)
```
colorPrimary:    #00E5CC  (turquesa Tanit)
colorBackground: #080c14  (fondo oscuro)
colorDanger:     #F6465D  (rojo Bybit)
fontFamily:      Plus Jakarta Sans
```

---

## Base de datos

Conexión via `@workspace/db` (pool pg). Connection string en `DATABASE_URL`.

Para operaciones de producción usar `environment: "production"` (Replit database skill).

### Pruner automático

`_scheduleHistoryPruner()` (línea ~309 de trading-engine.ts) ejecuta cada 6h:
- `pruneSwapHistory` — retiene últimos 200 eventos
- `pruneSignalOutcomes` — retiene últimas 500 señales
- `pruneTanitTradeContext` — retiene últimos 200 contextos
- `pruneTanitEvolutions` — retiene últimas 100 evoluciones

---

## Variables de entorno del servidor

```
BYBIT_API_KEY / BYBIT_API_SECRET  ← Mainnet UID 555753345
GEMINI_API_KEY                    ← Gemini 2.0 para sentimiento + chat
PERPLEXITY_API_KEY                ← News feed
TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY
DATABASE_URL                      ← PostgreSQL (Neon)
SESSION_SECRET
PORT                              ← Asignado por Replit (default 8080)
```

---

## Flujo de arranque del motor

```
index.ts
  └── loadState()
        ├── cleanStaleOpenTrades()  ← reconcilia DB vs Bybit
        ├── restaura state desde bot_state (key='main')
        ├── sync balance con Bybit (ignora si equity < $0.50)
        └── auto-relanza si wasActive=true AND NOT userStopped
              └── startEngine(mode, capitalPct, ..., liveMode=true)
                    ├── startBybitWs(symbols)
                    ├── startSlTpFastLoop()
                    ├── startPositionMonitor()
                    └── escaleraV2Scan() [loop principal cada ~30s]
```

---

## Áreas identificadas para revisión en Cursor

Estas son las secciones que el revisor debería verificar con más cuidado:

1. **`escaleraV2ScanSymbol` (~líneas 2652–3086)** — lógica de entrada más compleja del motor.
   Verificar: cálculo de score, condiciones de hedge gate, manejo de capa 1 vs capas adicionales.

2. **`_runSlTpFastLoopInner` (~líneas 1067–1490)** — loop crítico de 2s.
   Verificar: condiciones de lock-in SL, trailing TP, cierre por momentum negativo.

3. **`fetchGeminiSentiment` (~líneas 3538–3620)** — llamada a Gemini.
   Verificar: prompt engineering, manejo de errores de API, timeout.

4. **`routes/bot.ts` líneas 402–575** — endpoint `/bot/trades/db`.
   Verificar: paginación, filtros, joins con tablas relacionadas.

5. **`clerkProxyMiddleware.ts`** — proxy reverso a Clerk FAPI.
   Verificar: manejo de headers, casos edge con cookies cross-domain.

6. **`seedTanitIdentity` (~líneas 1588–1681)** — identidad de Tanit en DB.
   Verificar: UPSERT correcto, no sobrescribe memoria existente.

---

## Reglas para el revisor

> Antes de modificar cualquier lógica de trading, leer esta sección.

- `SIM_INITIAL_BALANCE` es una constante de fallback — no confundir con el balance real.
- `state.simBalance` en `liveMode=true` refleja el equity real de Bybit (no es simulado pese al nombre).
- El campo `inceptionCapital` es inmutable en condiciones normales — no resetear.
- La función `emergencyKill()` usa `bybitCloseMainnet` directamente — no usa el motor.
- Cualquier cambio en el formato de `buildStateData()` debe ser retrocompatible con datos existentes en DB.
- Los `calibrationHistory` (máx 5 ciclos) son el "aprendizaje" acumulado — no truncar sin intención.
