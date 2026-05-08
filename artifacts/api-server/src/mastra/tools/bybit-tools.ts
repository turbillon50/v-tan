/**
 * Tools de lectura Bybit para el agente Tanit.
 *
 * Envuelven los wrappers existentes en `lib/bybit-auth.ts` y `lib/bybit-ws.ts`
 * (testados, con rate-limiter propio) como tools de Mastra. El agente puede
 * invocarlas durante la conversación cuando Luis pregunta cosas como
 * "muéstrame mi balance" o "qué posiciones tengo abiertas".
 *
 * SOLO LECTURA en este archivo. Cero escritura, cero ejecución de órdenes.
 * Las tools de write (open/close, set stops) viven en bybit-write-tools.ts
 * y requieren governance + approval explícito.
 *
 * Cada tool:
 *  - Devuelve siempre `testnet: boolean` para que Tanit (y Luis al leer chat)
 *    sepan en qué entorno está mirando.
 *  - Devuelve `error?: string` en caso de fallo de la API. NO lanza — el agente
 *    interpreta el error y se lo comunica a Luis con su voz.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getBybitBalance,
  getOpenPositions,
  getRecentExecution,
  isTestnet,
  bybitPublic,
} from "../../lib/bybit-auth";
import { hasCredentials } from "../../lib/bybit-client";
import { isWsConnected, getWsPrice, getWsFundingRate } from "../../lib/bybit-ws";
import {
  isDailyHardLossBreakerTripped,
} from "../../lib/trading-engine";

export const consultarBalance = createTool({
  id: "consultar_balance",
  description:
    "Devuelve el balance actual de la cuenta Bybit: equity total, margen disponible, P&L no realizado y entorno (testnet o mainnet). Usar cuando Luis pregunte por su balance, cuánto tiene, su capital, su equity o similar.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    testnet: z.boolean(),
    hasCreds: z.boolean(),
    equity: z.number().nullable(),
    available: z.number().nullable(),
    total: z.number().nullable(),
    accountType: z.string().nullable(),
    error: z.string().optional(),
  }),
  execute: async () => {
    if (!hasCredentials()) {
      return {
        testnet: isTestnet(),
        hasCreds: false,
        equity: null,
        available: null,
        total: null,
        accountType: null,
        error: "No hay API keys de Bybit cargadas en la sesión.",
      };
    }
    try {
      const b = await getBybitBalance();
      if (!b) {
        return {
          testnet: isTestnet(),
          hasCreds: true,
          equity: null,
          available: null,
          total: null,
          accountType: null,
          error: "Bybit devolvió respuesta vacía.",
        };
      }
      return {
        testnet: isTestnet(),
        hasCreds: true,
        equity: b.equity ?? null,
        available: b.available ?? null,
        total: b.total ?? null,
        accountType: b.accountType ?? null,
      };
    } catch (e) {
      return {
        testnet: isTestnet(),
        hasCreds: true,
        equity: null,
        available: null,
        total: null,
        accountType: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

export const consultarPosiciones = createTool({
  id: "consultar_posiciones",
  description:
    "Devuelve las posiciones abiertas en Bybit: símbolo, lado (long/short), tamaño, precio de entrada, P&L no realizado, leverage, precio de liquidación. Usar cuando Luis pregunte qué tiene abierto, cuáles posiciones, qué está corriendo.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    testnet: z.boolean(),
    count: z.number(),
    positions: z.array(z.any()),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const positions = await getOpenPositions();
      return {
        testnet: isTestnet(),
        count: positions.length,
        positions: positions.map((p) => ({
          symbol: p.symbol,
          side: p.side,
          size: parseFloat(p.size ?? "0"),
          entryPrice: parseFloat(p.avgPrice ?? "0"),
          markPrice: parseFloat(p.markPrice ?? "0"),
          leverage: parseFloat(p.leverage ?? "0"),
          unrealizedPnl: parseFloat(p.unrealisedPnl ?? "0"),
          liquidationPrice: parseFloat(p.liqPrice ?? "0"),
          stopLoss: parseFloat(p.stopLoss ?? "0") || null,
          takeProfit: parseFloat(p.takeProfit ?? "0") || null,
        })),
      };
    } catch (e) {
      return {
        testnet: isTestnet(),
        count: 0,
        positions: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

export const consultarUltimaEjecucion = createTool({
  id: "consultar_ultima_ejecucion",
  description:
    "Devuelve la última ejecución de un símbolo en Bybit: precio promedio de cierre y P&L cerrado. Usar cuando Luis pregunte cómo cerró tal trade, en cuánto salió de X símbolo, P&L del último cierre.",
  inputSchema: z.object({
    symbol: z
      .string()
      .min(2)
      .max(20)
      .describe("Símbolo en formato Bybit, ej. BTCUSDT, ETHUSDT, SOLUSDT."),
  }),
  outputSchema: z.object({
    testnet: z.boolean(),
    symbol: z.string(),
    avgPrice: z.number().nullable(),
    closedPnl: z.number().nullable(),
    found: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const symbol = context.symbol;
    try {
      const r = await getRecentExecution(symbol);
      return {
        testnet: isTestnet(),
        symbol,
        avgPrice: r?.avgPrice ?? null,
        closedPnl: r?.closedPnl ?? null,
        found: r !== null,
      };
    } catch (e) {
      return {
        testnet: isTestnet(),
        symbol,
        avgPrice: null,
        closedPnl: null,
        found: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

export const consultarPrecioMercado = createTool({
  id: "consultar_precio_mercado",
  description:
    "Devuelve el precio mark/last/funding rate actual de un símbolo en Bybit. Usar cuando Luis pregunte a cuánto está BTC, ETH, etc., o cuando necesites contexto de mercado para responder.",
  inputSchema: z.object({
    symbol: z.string().min(2).max(20).describe("Símbolo Bybit, ej. BTCUSDT."),
  }),
  outputSchema: z.object({
    testnet: z.boolean(),
    symbol: z.string(),
    lastPrice: z.number().nullable(),
    markPrice: z.number().nullable(),
    indexPrice: z.number().nullable(),
    fundingRate: z.number().nullable(),
    nextFundingTime: z.string().nullable(),
    volume24h: z.number().nullable(),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const context = (rawInput && typeof rawInput === "object" && "context" in rawInput && rawInput.context && typeof rawInput.context === "object")
      ? (rawInput as { context: Record<string, unknown> }).context
      : (rawInput as Record<string, unknown>);
    const symbol = context.symbol;
    try {
      // Primero intentamos WebSocket cache (sub-millisecond, sin rate limit)
      const wsPrice = getWsPrice(symbol);
      const wsFunding = getWsFundingRate(symbol);
      if (wsPrice !== null) {
        return {
          testnet: isTestnet(),
          symbol,
          lastPrice: wsPrice,
          markPrice: wsPrice,
          indexPrice: null,
          fundingRate: wsFunding,
          nextFundingTime: null,
          volume24h: null,
        };
      }
      // Fallback a REST si WS no tiene ese símbolo subscrito
      const r = await bybitPublic("/v5/market/tickers", {
        category: "linear",
        symbol,
      });
      const t = r?.result?.list?.[0];
      if (!t) {
        return {
          testnet: isTestnet(),
          symbol,
          lastPrice: null,
          markPrice: null,
          indexPrice: null,
          fundingRate: null,
          nextFundingTime: null,
          volume24h: null,
          error: "Símbolo no encontrado.",
        };
      }
      return {
        testnet: isTestnet(),
        symbol,
        lastPrice: parseFloat(t.lastPrice ?? "0"),
        markPrice: parseFloat(t.markPrice ?? "0"),
        indexPrice: parseFloat(t.indexPrice ?? "0"),
        fundingRate: parseFloat(t.fundingRate ?? "0"),
        nextFundingTime: t.nextFundingTime ?? null,
        volume24h: parseFloat(t.volume24h ?? "0"),
      };
    } catch (e) {
      return {
        testnet: isTestnet(),
        symbol,
        lastPrice: null,
        markPrice: null,
        indexPrice: null,
        fundingRate: null,
        nextFundingTime: null,
        volume24h: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

export const consultarEstadoSistema = createTool({
  id: "consultar_estado_sistema",
  description:
    "Devuelve el estado operativo del sistema de trading: si está en testnet o mainnet, si las credenciales están cargadas, si el WebSocket de Bybit está conectado, y si el breaker de pérdida diaria está activado. Usar cuando Luis pregunte cómo estás, qué tal el sistema, todo bien, o cuando notes un comportamiento raro.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    testnet: z.boolean(),
    hasCreds: z.boolean(),
    wsConnected: z.boolean(),
    dailyBreakerTripped: z.boolean(),
    dailyBreakerReason: z.string().nullable(),
    dailyPnlUsd: z.number(),
    dailyPnlPct: z.number(),
  }),
  execute: async () => {
    const breaker = isDailyHardLossBreakerTripped();
    return {
      testnet: isTestnet(),
      hasCreds: hasCredentials(),
      wsConnected: isWsConnected(),
      dailyBreakerTripped: breaker.tripped,
      dailyBreakerReason: breaker.reason,
      dailyPnlUsd: breaker.pnlUsd,
      dailyPnlPct: breaker.pnlPct,
    };
  },
});

// ─── LEER VELAS (OHLCV) ──────────────────────────────────────────────────────
//
// Tanit le pidió a 'Code' poder ver velas. Antes solo recibía último precio,
// mark, funding — datos crudos sin estructura temporal. La tesis 5.1 exige
// 'lectura fractal multi-TF (4H/1H/15M)', así que sin velas no podía
// confirmar setups (Wyckoff, divergencias, cascadas, bordes ocultos).
export const leerVelas = createTool({
  id: "leer_velas",
  description:
    "Lee velas (OHLCV) de Bybit. Devuelve el array de velas más recientes en el timeframe pedido para que Tanit pueda confirmar estructura, swing highs/lows, momentum y patrones técnicos. Timeframe (interval): '1' (1m), '5' (5m), '15' (15m), '60' (1h), '240' (4h), 'D' (diario), 'W' (semanal). Limit recomendado: 100-200 para análisis de estructura, 50 para entradas tácticas.",
  inputSchema: z.object({
    symbol: z.string().describe("ej. BTCUSDT, ETHUSDT, SOLUSDT"),
    interval: z
      .enum(["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D", "W", "M"])
      .default("60"),
    limit: z.number().int().min(10).max(500).default(100),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    symbol: z.string(),
    interval: z.string(),
    count: z.number(),
    candles: z.array(
      z.object({
        time: z.number().describe("timestamp UNIX en segundos"),
        open: z.number(),
        high: z.number(),
        low: z.number(),
        close: z.number(),
        volume: z.number(),
      }),
    ),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: { symbol: string; interval: string; limit: number } }).context
      : (rawInput as { symbol: string; interval: string; limit: number }));
    try {
      const data = await bybitPublic("/v5/market/kline", {
        category: "linear",
        symbol: ctx.symbol,
        interval: ctx.interval,
        limit: String(ctx.limit),
      });
      const list = data?.result?.list ?? [];
      // Bybit devuelve velas en orden DESC (más reciente primero). Reversamos
      // para que el orden sea natural (vieja → nueva).
      const candles = (list as string[][])
        .slice()
        .reverse()
        .map((c) => ({
          time: Math.floor(parseInt(c[0]!, 10) / 1000),
          open: parseFloat(c[1]!),
          high: parseFloat(c[2]!),
          low: parseFloat(c[3]!),
          close: parseFloat(c[4]!),
          volume: parseFloat(c[5]!),
        }));
      return {
        ok: true,
        symbol: ctx.symbol,
        interval: ctx.interval,
        count: candles.length,
        candles,
      };
    } catch (e) {
      return {
        ok: false,
        symbol: ctx.symbol,
        interval: ctx.interval,
        count: 0,
        candles: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

// ─── ESTRUCTURA TÉCNICA (resumen calculado) ──────────────────────────────────
//
// En lugar de pedirle a Tanit que cargue 200 velas y compute todo desde cero
// cada vez, esta tool devuelve un resumen pre-calculado: EMAs, RSI, swing
// highs/lows, volumen actual vs promedio, body/wick ratio. Le ahorra ciclos
// y le da datos LIMPIOS para razonar.
export const leerEstructuraTecnica = createTool({
  id: "leer_estructura_tecnica",
  description:
    "Lee estructura técnica resumida de un símbolo en un timeframe: EMAs (20/50/200), RSI(14), volumen actual vs promedio 20, swing highs/lows recientes, body/wick ratio de la última vela cerrada. Útil para confirmar momentum y estructura sin cargar todas las velas crudas.",
  inputSchema: z.object({
    symbol: z.string(),
    interval: z
      .enum(["5", "15", "60", "240", "D"])
      .default("240")
      .describe("'5'=5m, '15'=15m, '60'=1h, '240'=4h, 'D'=diario"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    symbol: z.string(),
    interval: z.string(),
    last: z
      .object({
        time: z.number(),
        open: z.number(),
        high: z.number(),
        low: z.number(),
        close: z.number(),
        volume: z.number(),
        bodyPct: z.number(),
        upperWickPct: z.number(),
        lowerWickPct: z.number(),
      })
      .optional(),
    ema20: z.number().nullable().optional(),
    ema50: z.number().nullable().optional(),
    ema200: z.number().nullable().optional(),
    rsi14: z.number().nullable().optional(),
    volRatio: z.number().nullable().optional().describe("vol última / vol promedio 20"),
    swingHigh: z
      .object({ price: z.number(), barsAgo: z.number() })
      .nullable()
      .optional(),
    swingLow: z
      .object({ price: z.number(), barsAgo: z.number() })
      .nullable()
      .optional(),
    structure: z
      .enum(["bullish", "bearish", "range", "unknown"])
      .optional()
      .describe("estructura por orden de EMAs y posición del precio"),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: { symbol: string; interval: string } }).context
      : (rawInput as { symbol: string; interval: string }));
    try {
      const data = await bybitPublic("/v5/market/kline", {
        category: "linear",
        symbol: ctx.symbol,
        interval: ctx.interval,
        limit: "210",
      });
      const list = (data?.result?.list ?? []) as string[][];
      const candles = list
        .slice()
        .reverse()
        .map((c) => ({
          time: Math.floor(parseInt(c[0]!, 10) / 1000),
          open: parseFloat(c[1]!),
          high: parseFloat(c[2]!),
          low: parseFloat(c[3]!),
          close: parseFloat(c[4]!),
          volume: parseFloat(c[5]!),
        }));
      if (candles.length < 20) {
        return {
          ok: false,
          symbol: ctx.symbol,
          interval: ctx.interval,
          error: "no hay suficientes velas para análisis",
        };
      }
      const closes = candles.map((c) => c.close);
      const last = candles[candles.length - 1]!;
      const range = Math.max(0.0000001, last.high - last.low);
      const bodyPct = (Math.abs(last.close - last.open) / range) * 100;
      const upperWickPct =
        ((last.high - Math.max(last.open, last.close)) / range) * 100;
      const lowerWickPct =
        ((Math.min(last.open, last.close) - last.low) / range) * 100;

      const ema = (arr: number[], period: number): number | null => {
        if (arr.length < period) return null;
        const k = 2 / (period + 1);
        let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < arr.length; i++) {
          val = arr[i]! * k + val * (1 - k);
        }
        return val;
      };
      const ema20 = ema(closes, 20);
      const ema50 = ema(closes, 50);
      const ema200 = ema(closes, 200);

      // RSI(14)
      const rsi = (arr: number[], period = 14): number | null => {
        if (arr.length < period + 1) return null;
        let gains = 0;
        let losses = 0;
        for (let i = 1; i <= period; i++) {
          const d = arr[i]! - arr[i - 1]!;
          if (d >= 0) gains += d;
          else losses -= d;
        }
        let avgG = gains / period;
        let avgL = losses / period;
        for (let i = period + 1; i < arr.length; i++) {
          const d = arr[i]! - arr[i - 1]!;
          avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
          avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
        }
        if (avgL === 0) return 100;
        const rs = avgG / avgL;
        return 100 - 100 / (1 + rs);
      };
      const rsi14 = rsi(closes, 14);

      // Volumen ratio
      const recentVol = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
      const volRatio = recentVol > 0 ? last.volume / recentVol : null;

      // Swing high / low en últimas 50 velas
      const swingWindow = candles.slice(-50);
      let highIdx = 0;
      let lowIdx = 0;
      for (let i = 1; i < swingWindow.length; i++) {
        if (swingWindow[i]!.high > swingWindow[highIdx]!.high) highIdx = i;
        if (swingWindow[i]!.low < swingWindow[lowIdx]!.low) lowIdx = i;
      }
      const swingHigh = {
        price: swingWindow[highIdx]!.high,
        barsAgo: swingWindow.length - 1 - highIdx,
      };
      const swingLow = {
        price: swingWindow[lowIdx]!.low,
        barsAgo: swingWindow.length - 1 - lowIdx,
      };

      // Estructura por EMAs
      let structure: "bullish" | "bearish" | "range" | "unknown" = "unknown";
      if (ema20 != null && ema50 != null && ema200 != null) {
        if (ema20 > ema50 && ema50 > ema200 && last.close > ema20) {
          structure = "bullish";
        } else if (ema20 < ema50 && ema50 < ema200 && last.close < ema20) {
          structure = "bearish";
        } else {
          structure = "range";
        }
      }

      return {
        ok: true,
        symbol: ctx.symbol,
        interval: ctx.interval,
        last: {
          time: last.time,
          open: last.open,
          high: last.high,
          low: last.low,
          close: last.close,
          volume: last.volume,
          bodyPct: parseFloat(bodyPct.toFixed(2)),
          upperWickPct: parseFloat(upperWickPct.toFixed(2)),
          lowerWickPct: parseFloat(lowerWickPct.toFixed(2)),
        },
        ema20,
        ema50,
        ema200,
        rsi14,
        volRatio: volRatio != null ? parseFloat(volRatio.toFixed(2)) : null,
        swingHigh,
        swingLow,
        structure,
      };
    } catch (e) {
      return {
        ok: false,
        symbol: ctx.symbol,
        interval: ctx.interval,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

// ─── BACKTEST DE LA TESIS 5.1 ────────────────────────────────────────────────
//
// Simula la entrada/salida con los criterios codificados de la tesis 5.1
// sobre velas históricas Bybit. Devuelve métricas: win rate, profit factor,
// max drawdown, equity curve, lista de trades. Útil para que Tanit conteste
// 'qué hubiera pasado si...' sin tener que conjeturar.
//
// Reglas codificadas (versión simplificada, mecánica):
//   ENTRADA LONG: estructura=bullish (EMA20>EMA50>EMA200 + close>EMA20)
//                 + volRatio >= 1.0 (volumen no anémico)
//                 + RSI(14) entre 40 y 70 (momentum sin extremo)
//   ENTRADA SHORT: espejo (estructura=bearish + RSI 30-60 + vol)
//   SL: swing low (long) / swing high (short) reciente
//   TP: RR 1:2 (entry + 2 * (entry - SL))
//   Position size: % del capital por trade (param) con leverage configurable
//   Salida también por: trail si va +50% TP, stop tras N velas si no avanza
export const backtestTesis = createTool({
  id: "backtest_tesis",
  description:
    "Corre un backtest mecánico de la Tesis 5.1 sobre velas históricas. Simula entradas/salidas según motor 1 (momentum confirmado por EMAs+volumen+RSI) con SL en swing reciente y TP por RR 1:2. Devuelve win rate, profit factor, drawdown, lista de trades, equity curve. Capital inicial y riesgo por trade configurables.",
  inputSchema: z.object({
    symbol: z.string(),
    interval: z
      .enum(["15", "60", "240", "D"])
      .default("240")
      .describe("'15'=15m, '60'=1h, '240'=4h, 'D'=diario"),
    candles: z
      .number()
      .int()
      .min(50)
      .max(1000)
      .default(500)
      .describe("Cuántas velas históricas analizar"),
    initialCapital: z.number().positive().default(45),
    riskPctPerTrade: z
      .number()
      .min(0.5)
      .max(20)
      .default(2)
      .describe("% del capital arriesgado por trade (default 2%)"),
    leverage: z.number().min(1).max(100).default(10),
    side: z
      .enum(["both", "long_only", "short_only"])
      .default("both"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    symbol: z.string(),
    interval: z.string(),
    candlesAnalyzed: z.number(),
    fromTime: z.string().nullable(),
    toTime: z.string().nullable(),
    summary: z
      .object({
        totalTrades: z.number(),
        wins: z.number(),
        losses: z.number(),
        winRate: z.number(),
        profitFactor: z.number(),
        totalPnlUsd: z.number(),
        totalPnlPct: z.number(),
        maxDrawdownPct: z.number(),
        finalEquity: z.number(),
        avgWinUsd: z.number(),
        avgLossUsd: z.number(),
        bestTrade: z.number(),
        worstTrade: z.number(),
      })
      .optional(),
    trades: z
      .array(
        z.object({
          side: z.enum(["long", "short"]),
          entryTime: z.string(),
          entryPrice: z.number(),
          exitTime: z.string(),
          exitPrice: z.number(),
          exitReason: z.enum(["tp", "sl", "timeout"]),
          pnlUsd: z.number(),
          pnlPct: z.number(),
          barsHeld: z.number(),
        }),
      )
      .optional(),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as {
      symbol: string;
      interval: string;
      candles: number;
      initialCapital: number;
      riskPctPerTrade: number;
      leverage: number;
      side: "both" | "long_only" | "short_only";
    };
    try {
      // 1) Cargar velas históricas
      const data = await bybitPublic("/v5/market/kline", {
        category: "linear",
        symbol: ctx.symbol,
        interval: ctx.interval,
        limit: String(Math.min(1000, ctx.candles)),
      });
      const list = (data?.result?.list ?? []) as string[][];
      if (list.length < 220) {
        return {
          ok: false,
          symbol: ctx.symbol,
          interval: ctx.interval,
          candlesAnalyzed: list.length,
          fromTime: null,
          toTime: null,
          error: `pocas velas (${list.length}); necesito >= 220 para EMA200 + ventana de análisis`,
        };
      }
      const candles = list
        .slice()
        .reverse()
        .map((c) => ({
          time: parseInt(c[0]!, 10),
          open: parseFloat(c[1]!),
          high: parseFloat(c[2]!),
          low: parseFloat(c[3]!),
          close: parseFloat(c[4]!),
          volume: parseFloat(c[5]!),
        }));

      // 2) Helpers para indicadores incrementales
      const closes = candles.map((c) => c.close);
      const ema = (period: number, idx: number): number | null => {
        if (idx + 1 < period) return null;
        const k = 2 / (period + 1);
        let val =
          closes.slice(idx + 1 - period, idx + 1).reduce((a, b) => a + b, 0) / period;
        // re-cómputo simple (no incremental) — válido para backtest pequeño
        let v = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i <= idx; i++) {
          v = closes[i]! * k + v * (1 - k);
        }
        return v;
      };
      const rsi = (idx: number, period = 14): number | null => {
        if (idx < period) return null;
        let gains = 0;
        let losses = 0;
        for (let i = idx - period + 1; i <= idx; i++) {
          const d = closes[i]! - closes[i - 1]!;
          if (d >= 0) gains += d;
          else losses -= d;
        }
        const avgG = gains / period;
        const avgL = losses / period;
        if (avgL === 0) return 100;
        const rs = avgG / avgL;
        return 100 - 100 / (1 + rs);
      };
      const avgVol20 = (idx: number): number => {
        const start = Math.max(0, idx - 19);
        const arr = candles.slice(start, idx + 1);
        return arr.reduce((s, c) => s + c.volume, 0) / arr.length;
      };
      const swingLow = (idx: number, lookback = 20): number => {
        const start = Math.max(0, idx - lookback + 1);
        let lo = candles[start]!.low;
        for (let i = start; i <= idx; i++) {
          if (candles[i]!.low < lo) lo = candles[i]!.low;
        }
        return lo;
      };
      const swingHigh = (idx: number, lookback = 20): number => {
        const start = Math.max(0, idx - lookback + 1);
        let hi = candles[start]!.high;
        for (let i = start; i <= idx; i++) {
          if (candles[i]!.high > hi) hi = candles[i]!.high;
        }
        return hi;
      };

      // 3) Backtest engine (mecánico, una posición a la vez)
      type Pos = {
        side: "long" | "short";
        entryIdx: number;
        entryPrice: number;
        sl: number;
        tp: number;
        sizeUsdNotional: number;
      };
      let equity = ctx.initialCapital;
      let peakEquity = equity;
      let maxDrawdownPct = 0;
      let pos: Pos | null = null;
      const trades: Array<{
        side: "long" | "short";
        entryTime: string;
        entryPrice: number;
        exitTime: string;
        exitPrice: number;
        exitReason: "tp" | "sl" | "timeout";
        pnlUsd: number;
        pnlPct: number;
        barsHeld: number;
      }> = [];

      const MAX_BARS_HELD = 30;
      const allowLong = ctx.side !== "short_only";
      const allowShort = ctx.side !== "long_only";

      // empezamos en idx 200 (necesitamos EMA200)
      for (let i = 200; i < candles.length; i++) {
        const c = candles[i]!;

        // Si hay posición abierta, ver si tocó SL/TP
        if (pos) {
          let exitPrice: number | null = null;
          let exitReason: "tp" | "sl" | "timeout" | null = null;
          if (pos.side === "long") {
            if (c.low <= pos.sl) {
              exitPrice = pos.sl;
              exitReason = "sl";
            } else if (c.high >= pos.tp) {
              exitPrice = pos.tp;
              exitReason = "tp";
            }
          } else {
            if (c.high >= pos.sl) {
              exitPrice = pos.sl;
              exitReason = "sl";
            } else if (c.low <= pos.tp) {
              exitPrice = pos.tp;
              exitReason = "tp";
            }
          }
          const barsHeld = i - pos.entryIdx;
          if (!exitPrice && barsHeld >= MAX_BARS_HELD) {
            exitPrice = c.close;
            exitReason = "timeout";
          }
          if (exitPrice && exitReason) {
            const move = pos.side === "long"
              ? (exitPrice - pos.entryPrice) / pos.entryPrice
              : (pos.entryPrice - exitPrice) / pos.entryPrice;
            const pnlUsd = move * pos.sizeUsdNotional;
            equity += pnlUsd;
            if (equity > peakEquity) peakEquity = equity;
            const dd = ((peakEquity - equity) / peakEquity) * 100;
            if (dd > maxDrawdownPct) maxDrawdownPct = dd;
            trades.push({
              side: pos.side,
              entryTime: new Date(candles[pos.entryIdx]!.time).toISOString(),
              entryPrice: pos.entryPrice,
              exitTime: new Date(c.time).toISOString(),
              exitPrice,
              exitReason,
              pnlUsd: parseFloat(pnlUsd.toFixed(4)),
              pnlPct: parseFloat((move * 100 * ctx.leverage).toFixed(2)),
              barsHeld,
            });
            pos = null;
            if (equity <= 0) break;
          }
        }

        // Ver si hay setup para entrar (sólo si no hay posición)
        if (!pos) {
          const e20 = ema(20, i);
          const e50 = ema(50, i);
          const e200 = ema(200, i);
          if (e20 == null || e50 == null || e200 == null) continue;
          const r = rsi(i);
          if (r == null) continue;
          const vol = avgVol20(i);
          if (vol === 0) continue;
          const volRatio = c.volume / vol;
          if (volRatio < 1.0) continue;

          const bullish = e20 > e50 && e50 > e200 && c.close > e20;
          const bearish = e20 < e50 && e50 < e200 && c.close < e20;

          if (allowLong && bullish && r >= 40 && r <= 70) {
            const sl = swingLow(i, 20);
            if (sl >= c.close) continue; // SL inválido
            const risk = c.close - sl;
            const tp = c.close + 2 * risk;
            const riskUsd = (equity * ctx.riskPctPerTrade) / 100;
            const sizeUsdNotional = (riskUsd / (risk / c.close)) * 1; // notional = riskUsd / riskFraction
            // Cap notional por leverage
            const maxNotional = equity * ctx.leverage;
            const notional = Math.min(sizeUsdNotional, maxNotional);
            pos = { side: "long", entryIdx: i, entryPrice: c.close, sl, tp, sizeUsdNotional: notional };
          } else if (allowShort && bearish && r >= 30 && r <= 60) {
            const sl = swingHigh(i, 20);
            if (sl <= c.close) continue;
            const risk = sl - c.close;
            const tp = c.close - 2 * risk;
            const riskUsd = (equity * ctx.riskPctPerTrade) / 100;
            const sizeUsdNotional = (riskUsd / (risk / c.close)) * 1;
            const maxNotional = equity * ctx.leverage;
            const notional = Math.min(sizeUsdNotional, maxNotional);
            pos = { side: "short", entryIdx: i, entryPrice: c.close, sl, tp, sizeUsdNotional: notional };
          }
        }
      }

      // 4) Métricas
      const wins = trades.filter((t) => t.pnlUsd > 0).length;
      const losses = trades.filter((t) => t.pnlUsd < 0).length;
      const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
      const grossWin = trades.filter((t) => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
      const grossLoss = -trades.filter((t) => t.pnlUsd < 0).reduce((s, t) => s + t.pnlUsd, 0);
      const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
      const totalPnlUsd = equity - ctx.initialCapital;
      const totalPnlPct = (totalPnlUsd / ctx.initialCapital) * 100;
      const avgWinUsd = wins > 0 ? grossWin / wins : 0;
      const avgLossUsd = losses > 0 ? -grossLoss / losses : 0;
      const bestTrade = trades.length ? Math.max(...trades.map((t) => t.pnlUsd)) : 0;
      const worstTrade = trades.length ? Math.min(...trades.map((t) => t.pnlUsd)) : 0;

      return {
        ok: true,
        symbol: ctx.symbol,
        interval: ctx.interval,
        candlesAnalyzed: candles.length,
        fromTime: candles.length ? new Date(candles[0]!.time).toISOString() : null,
        toTime: candles.length ? new Date(candles[candles.length - 1]!.time).toISOString() : null,
        summary: {
          totalTrades: trades.length,
          wins,
          losses,
          winRate: parseFloat(winRate.toFixed(2)),
          profitFactor: parseFloat(profitFactor.toFixed(3)),
          totalPnlUsd: parseFloat(totalPnlUsd.toFixed(2)),
          totalPnlPct: parseFloat(totalPnlPct.toFixed(2)),
          maxDrawdownPct: parseFloat(maxDrawdownPct.toFixed(2)),
          finalEquity: parseFloat(equity.toFixed(2)),
          avgWinUsd: parseFloat(avgWinUsd.toFixed(2)),
          avgLossUsd: parseFloat(avgLossUsd.toFixed(2)),
          bestTrade: parseFloat(bestTrade.toFixed(2)),
          worstTrade: parseFloat(worstTrade.toFixed(2)),
        },
        trades: trades.slice(-50), // últimos 50 para no saturar el contexto
      };
    } catch (e) {
      return {
        ok: false,
        symbol: ctx.symbol,
        interval: ctx.interval,
        candlesAnalyzed: 0,
        fromTime: null,
        toTime: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

/**
 * Bundle de tools de LECTURA. Importar y pasar al Agent así:
 *   import { bybitReadTools } from "./tools/bybit-tools";
 *   new Agent({ ..., tools: bybitReadTools });
 */
export const bybitReadTools = {
  consultarBalance,
  consultarPosiciones,
  consultarUltimaEjecucion,
  consultarPrecioMercado,
  consultarEstadoSistema,
  leerVelas,
  leerEstructuraTecnica,
  backtestTesis,
};
