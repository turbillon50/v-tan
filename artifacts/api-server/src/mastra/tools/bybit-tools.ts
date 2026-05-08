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
  execute: async ({ context }) => {
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
  execute: async ({ context }) => {
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
};
