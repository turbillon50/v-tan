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
};
