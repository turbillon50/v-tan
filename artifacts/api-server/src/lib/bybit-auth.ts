import { createHmac } from "crypto";
import { getKey } from "./api-keys-provider";

let useTestnet = true;
const MAINNET_URL = "https://api.bybit.com";
const TESTNET_URL = "https://api-testnet.bybit.com";
const RECV_WINDOW = "5000";

export function setTestnet(enabled: boolean) { useTestnet = enabled; }
export function isTestnet() { return useTestnet; }
function getBaseUrl() { return useTestnet ? TESTNET_URL : MAINNET_URL; }

function sign(secret: string, ts: string, payload: string, apiKey: string): string {
  return createHmac("sha256", secret)
    .update(ts + apiKey + RECV_WINDOW + payload)
    .digest("hex");
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITER — Token bucket por categoría de endpoint
// Bybit limits:  Market data = 120 req/s,  Private = 10 req/s,  Orders = 10 req/s
// Usamos 70% del límite real como techo seguro para nunca acercarnos al 429.
// ═══════════════════════════════════════════════════════════════════════════════
interface RateBucket {
  tokens: number;
  maxTokens: number;
  refillRate: number;
  lastRefill: number;
}

const rateBuckets: Record<string, RateBucket> = {
  public:  { tokens: 118, maxTokens: 118, refillRate: 118, lastRefill: Date.now() },
  private: { tokens: 10,  maxTokens: 10,  refillRate: 10,  lastRefill: Date.now() },
  order:   { tokens: 10,  maxTokens: 10,  refillRate: 10,  lastRefill: Date.now() },
};

function refillBucket(bucket: RateBucket): void {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
  bucket.lastRefill = now;
}

async function acquireToken(category: string): Promise<void> {
  const bucket = rateBuckets[category] ?? rateBuckets.public;
  refillBucket(bucket);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }

  const waitMs = Math.ceil((1 - bucket.tokens) / bucket.refillRate * 1000);
  rlStats.throttledCount++;
  await new Promise(r => setTimeout(r, waitMs));
  refillBucket(bucket);
  bucket.tokens = Math.max(0, bucket.tokens - 1);
}

function classifyPath(path: string): string {
  if (path.includes("/order/")) return "order";
  if (path.includes("/position/") || path.includes("/account/")) return "private";
  return "public";
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMIT STATS — para monitoreo desde el dashboard
// ═══════════════════════════════════════════════════════════════════════════════
const rlStats = {
  totalCalls: 0,
  cacheHits: 0,
  throttledCount: 0,
  rateLimited429: 0,
  lastMinuteCalls: 0,
  lastMinuteStart: Date.now(),
};

export function getRateLimitStats() {
  const now = Date.now();
  if (now - rlStats.lastMinuteStart > 60_000) {
    rlStats.lastMinuteCalls = 0;
    rlStats.lastMinuteStart = now;
  }
  return {
    totalCalls: rlStats.totalCalls,
    cacheHits: rlStats.cacheHits,
    throttledCount: rlStats.throttledCount,
    rateLimited429: rlStats.rateLimited429,
    callsPerMinute: rlStats.lastMinuteCalls,
    buckets: Object.fromEntries(
      Object.entries(rateBuckets).map(([k, b]) => {
        refillBucket(b);
        return [k, { tokens: Math.floor(b.tokens), max: b.maxTokens }];
      })
    ),
  };
}

function trackCall() {
  rlStats.totalCalls++;
  rlStats.lastMinuteCalls++;
  const now = Date.now();
  if (now - rlStats.lastMinuteStart > 60_000) {
    rlStats.lastMinuteCalls = 1;
    rlStats.lastMinuteStart = now;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE API FUNCTIONS — con rate limiting integrado + retry en 429
// ═══════════════════════════════════════════════════════════════════════════════

export async function bybitPrivate(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {}
): Promise<any> {
  const category = classifyPath(path);
  await acquireToken(category);
  trackCall();

  // PR #40 — fallback inteligente: si no hay bybit_key/secret accesibles,
  // usar proxy automáticamente (donde sí viven). Sin requerir FORCE_PROXY.
  const directKey   = await getKey("bybit_key");
  const directSec   = await getKey("bybit_secret");
  const hasDirect   = !!(directKey && directSec);
  const proxyUrl    = process.env.BYBIT_PROXY_URL;
  const useProxy    = !!proxyUrl && (process.env.FORCE_PROXY === "1" || !hasDirect);
  const proxySecret = (await getKey("proxy_secret")) ?? "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let result: any;

      if (useProxy && proxyUrl) {
        const res = await fetch(`${proxyUrl.replace(/\/$/, "")}/proxy`, {
          method: "POST",
          headers: {
            "Content-Type":    "application/json",
            "x-proxy-secret":  proxySecret,
          },
          body: JSON.stringify({ method, path, params, proxySecret }),
          signal: AbortSignal.timeout(12000),
        });

        if (res.status === 429) {
          rlStats.rateLimited429++;
          console.warn(`[bybit] ⚠️ 429 RATE LIMITED en ${path} — esperando ${attempt}s`);
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }

        result = await res.json();
      } else {
        const key    = directKey ?? "";
        const secret = directSec ?? "";
        if (!key || !secret) throw new Error("bybit_key / bybit_secret no configurados (DB, env o proxy)");

        const ts = Date.now().toString();
        let url    = `${getBaseUrl()}${path}`;
        let body: string | undefined;
        let payload: string;

        if (method === "GET") {
          const qs = new URLSearchParams(params as Record<string, string>).toString();
          payload  = qs;
          if (qs) url += `?${qs}`;
        } else {
          body    = JSON.stringify(params);
          payload = body;
        }

        const sig = sign(secret, ts, payload, key);

        const res = await fetch(url, {
          method,
          headers: {
            "Content-Type":        "application/json",
            "X-BAPI-API-KEY":      key,
            "X-BAPI-TIMESTAMP":    ts,
            "X-BAPI-SIGN":         sig,
            "X-BAPI-RECV-WINDOW":  RECV_WINDOW,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (res.status === 429) {
          rlStats.rateLimited429++;
          console.warn(`[bybit] ⚠️ 429 RATE LIMITED en ${path} — esperando ${attempt}s`);
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }

        const text = await res.text();
        if (!text || text.trim() === "") return { retCode: 0, retMsg: "OK" };
        try { result = JSON.parse(text); } catch { return { retCode: -1, retMsg: text }; }
      }

      if (result?.retCode === 10006 || result?.retCode === 10018) {
        rlStats.rateLimited429++;
        console.warn(`[bybit] ⚠️ Rate limit retCode=${result.retCode} en ${path} — retry ${attempt}`);
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }

      return result;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { retCode: -1, retMsg: "Max retries exceeded" };
}

export async function bybitPublic(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {}
): Promise<any> {
  // PR #40 — public endpoints: si tenemos proxy y NO tenemos keys directas,
  // los pasamos por proxy también (consistente con private). Si tenemos keys
  // directas, vamos directo (más rápido, sin auth necesaria para market data).
  if (process.env.BYBIT_PROXY_URL) {
    const dKey = await getKey("bybit_key");
    const dSec = await getKey("bybit_secret");
    if (process.env.FORCE_PROXY === "1" || !(dKey && dSec)) {
      return bybitPrivate(method, path, params);
    }
  }

  await acquireToken("public");
  trackCall();

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let url = `${getBaseUrl()}${path}`;
      let body: string | undefined;
      if (method === "GET") {
        const qs = new URLSearchParams(params as Record<string, string>).toString();
        if (qs) url += `?${qs}`;
      } else { body = JSON.stringify(params); }

      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(15000) });

      if (res.status === 429) {
        rlStats.rateLimited429++;
        console.warn(`[bybit] ⚠️ 429 PUBLIC en ${path} — retry ${attempt}`);
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }

      return res.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return { retCode: -1, retMsg: "Max retries exceeded" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BALANCE CACHE — evita 15+ llamadas por scan cycle (TTL 5s)
// ═══════════════════════════════════════════════════════════════════════════════
type BalanceResult = { available: number; total: number; equity: number; accountType: string; usdtWalletBalance: number };
let _balanceCache: { data: BalanceResult; cachedAt: number } | null = null;
const BALANCE_CACHE_TTL = 5_000;

export async function getBybitBalanceMainnet(): Promise<{ available: number; total: number; equity: number; accountType: string } | null> {
  const b = await getBybitBalance();
  return b;
}

export async function getBybitBalance(): Promise<BalanceResult | null> {
  if (_balanceCache && Date.now() - _balanceCache.cachedAt < BALANCE_CACHE_TTL) {
    rlStats.cacheHits++;
    return _balanceCache.data;
  }

  const accountTypes = ["UNIFIED", "SPOT", "CONTRACT"];
  for (const accountType of accountTypes) {
    try {
      const d = await bybitPrivate("GET", "/v5/account/wallet-balance", { accountType });
      const list0 = d?.result?.list?.[0];
      if (!list0) continue;

      const accountTotalEquity = parseFloat(list0.totalEquity || "0");
      const coin = list0?.coin?.find((c: any) => c.coin === "USDT");
      const coinEquity = parseFloat(coin?.equity || coin?.walletBalance || "0");
      const equity = accountTotalEquity > 0 ? accountTotalEquity : coinEquity;
      if (equity <= 0) continue;

      const usdtWalletBalance = parseFloat(coin?.walletBalance || coin?.equity || "0");
      // Usar totalAvailableBalance de Bybit (campo oficial para nuevas órdenes)
      const totalAvailableBalance = parseFloat(list0.totalAvailableBalance || "0");
      const totalInitialMargin    = parseFloat(list0.totalInitialMargin || "0");
      const totalMaintMargin      = parseFloat(list0.totalMaintenanceMargin || "0");
      const coinAvailToWithdraw   = parseFloat(coin?.availableToWithdraw || "0");
      // coin.availableBalance = lo que Bybit app muestra como "disponible para trading"
      // En cuentas UNIFIED nuevas, este campo tiene el saldo; totalAvailableBalance puede ser 0
      const coinAvailBalance      = parseFloat(coin?.availableBalance || "0");

      // Prioridad de disponible (de más confiable a fallback):
      // 1. totalAvailableBalance — campo oficial multi-activo de Bybit
      // 2. coin.availableBalance — lo que muestra la app Bybit ("Saldo disponible")
      // 3. coin.availableToWithdraw — USDT retirarle (a veces igual que 2)
      // 4. walletBalance - initialMargin — cálculo manual conservador
      // 5. equity — fallback final si todo lo demás es 0 (cuenta sin posiciones)
      const available =
        totalAvailableBalance > 0 ? totalAvailableBalance
        : coinAvailBalance      > 0 ? coinAvailBalance
        : coinAvailToWithdraw   > 0 ? coinAvailToWithdraw
        : usdtWalletBalance     > 0 ? Math.max(0, usdtWalletBalance - totalInitialMargin)
        : equity;  // último recurso: la cuenta tiene dinero aunque no reporte disponible

      const result: BalanceResult = {
        available: Number.isFinite(available) && available >= 0 ? available : equity,
        total: equity, equity, accountType, usdtWalletBalance,
      };

      _balanceCache = { data: result, cachedAt: Date.now() };
      return result;
    } catch { continue; }
  }
  return null;
}

export function invalidateBalanceCache(): void {
  _balanceCache = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QTY RULES — cache 24h (instrument specs casi nunca cambian)
// ═══════════════════════════════════════════════════════════════════════════════
const _qtyCache: Record<string, { min: number; step: number; dp: number; fetchedAt: number }> = {};
const QTY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function fetchQtyRule(symbol: string): Promise<{ min: number; step: number; dp: number }> {
  const cached = _qtyCache[symbol];
  if (cached && Date.now() - cached.fetchedAt < QTY_CACHE_TTL_MS) {
    rlStats.cacheHits++;
    return { min: cached.min, step: cached.step, dp: cached.dp };
  }
  try {
    const d = await bybitPublic("GET", "/v5/market/instruments-info", { category: "linear", symbol });
    const info = d?.result?.list?.[0];
    const lot  = info?.lotSizeFilter;
    if (lot) {
      const step = parseFloat(lot.qtyStep   ?? "0.001");
      const min  = parseFloat(lot.minOrderQty ?? lot.minQty ?? String(step));
      const dp   = (step.toString().split(".")[1] ?? "").length;
      const rule = { min, step, dp, fetchedAt: Date.now() };
      _qtyCache[symbol] = rule;
      return rule;
    }
  } catch (e) {
    console.error("[bybit] fetchQtyRule error:", symbol, e);
  }
  return QTY_RULES_LOCAL[symbol] ?? { min: 0.001, step: 0.001, dp: 3 };
}

export async function calcQtyReal(symbol: string, capitalUSDT: number, leverage: number, price: number): Promise<string | null> {
  const rule = await fetchQtyRule(symbol);
  const notional = capitalUSDT * leverage;
  const rawQty   = notional / price;
  let stepped    = Math.floor(rawQty / rule.step) * rule.step;
  // Si el nocional real queda por debajo del mínimo de Bybit ($5), subir un step
  const BYBIT_MIN_NOTIONAL = 5.0;
  if (stepped * price < BYBIT_MIN_NOTIONAL) stepped += rule.step;
  if (stepped < rule.min) return null;
  return stepped.toFixed(rule.dp);
}

const QTY_RULES_LOCAL: Record<string, { min: number; step: number; dp: number }> = {
  BTCUSDT:  { min: 0.001, step: 0.001, dp: 3 },
  ETHUSDT:  { min: 0.01,  step: 0.01,  dp: 2 },
  SOLUSDT:  { min: 0.1,   step: 0.1,   dp: 1 },
  AVAXUSDT: { min: 0.1,   step: 0.1,   dp: 1 },
  LINKUSDT: { min: 0.1,   step: 0.1,   dp: 1 },
  BNBUSDT:  { min: 0.01,  step: 0.01,  dp: 2 },
  XRPUSDT:  { min: 0.1,   step: 0.1,   dp: 1 },
  DOGEUSDT: { min: 1,     step: 1,     dp: 0 },
  ATOMUSDT: { min: 0.1,   step: 0.1,   dp: 1 },
  SUIUSDT:  { min: 10,    step: 10,    dp: 0 },
  BCHUSDT:  { min: 0.01,  step: 0.01,  dp: 2 },
  LTCUSDT:  { min: 0.1,   step: 0.1,   dp: 1 },
  ADAUSDT:  { min: 1,     step: 1,     dp: 0 },
  TONUSDT:  { min: 0.1,   step: 0.1,   dp: 1 },
  TRXUSDT:  { min: 1,     step: 1,     dp: 0 },
  NEARUSDT: { min: 0.1,   step: 0.1,   dp: 1 },
  DOTUSDT:  { min: 0.1,   step: 0.1,   dp: 1 },
  OPUSDT:   { min: 0.1,   step: 0.1,   dp: 1 },
  ARBUSDT:  { min: 0.1,   step: 0.1,   dp: 1 },
  INJUSDT:  { min: 0.1,   step: 0.1,   dp: 1 },
  AAVEUSDT: { min: 0.01,  step: 0.01,  dp: 2 },
};

/** @deprecated usa calcQtyReal */
export function calcQty(symbol: string, capitalUSDT: number, leverage: number, price: number): string | null {
  const cached = _qtyCache[symbol];
  const rule   = cached ?? QTY_RULES_LOCAL[symbol] ?? { min: 0.001, step: 0.001, dp: 3 };
  const notional = capitalUSDT * leverage;
  const rawQty   = notional / price;
  const stepped  = Math.floor(rawQty / rule.step) * rule.step;
  if (stepped < rule.min) return null;
  return stepped.toFixed(rule.dp);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADING OPERATIONS — rate-limited por diseño (usan bybitPrivate internamente)
// ═══════════════════════════════════════════════════════════════════════════════

export async function setLeverage(symbol: string, leverage: number): Promise<boolean> {
  try {
    await bybitPrivate("POST", "/v5/position/set-leverage", {
      category: "linear", symbol,
      buyLeverage:  String(leverage),
      sellLeverage: String(leverage),
    });
    return true;
  } catch { return false; }
}

export async function switchPositionMode(symbol: string, mode: 0 | 3): Promise<boolean> {
  try {
    const d = await bybitPrivate("POST", "/v5/position/switch-mode", {
      category: "linear", symbol, mode,
    });
    return d?.retCode === 0 || d?.retCode === 110025;
  } catch { return false; }
}

export async function placeMarketOrder(
  symbol: string, side: "Buy" | "Sell", qty: string,
  reduceOnly = false, positionIdx = 0
): Promise<string | null> {
  try {
    const d = await bybitPrivate("POST", "/v5/order/create", {
      category: "linear", symbol, side, orderType: "Market", qty,
      timeInForce: "GoodTillCancel", reduceOnly, positionIdx,
    });
    if (d?.retCode === 0) return d.result?.orderId ?? null;
    console.error("[bybit-real] placeMarketOrder error:", d?.retMsg, "retCode:", d?.retCode);
    return null;
  } catch (e) {
    console.error("[bybit-real] placeMarketOrder exception:", e);
    return null;
  }
}

export async function closePosition(
  symbol: string, direction: "LONG" | "SHORT", qty: string, positionIdx = 0
): Promise<boolean> {
  const side = direction === "LONG" ? "Sell" : "Buy";
  invalidateBalanceCache();
  const orderId = await placeMarketOrder(symbol, side, qty, true, positionIdx);
  return !!orderId;
}

export async function closePositionMainnet(
  symbol: string, direction: "LONG" | "SHORT", qty: string, positionIdx = 0
): Promise<boolean> {
  const side = direction === "LONG" ? "Sell" : "Buy";
  invalidateBalanceCache();
  try {
    const d = await bybitPrivate("POST", "/v5/order/create", {
      category: "linear", symbol, side, orderType: "Market", qty,
      timeInForce: "GoodTillCancel", reduceOnly: true, positionIdx,
    });
    if (d?.retCode === 0) return true;
    console.error("[bybit] closePositionMainnet error:", d?.retMsg);
    return false;
  } catch (e) {
    console.error("[bybit] closePositionMainnet exception:", e);
    return false;
  }
}

export async function setTradingStop(
  symbol: string, stopLoss?: number, takeProfit?: number | null, positionIdx = 0
): Promise<boolean> {
  try {
    const params: Record<string, unknown> = { category: "linear", symbol, positionIdx };
    if (stopLoss != null) params.stopLoss = String(stopLoss);
    if (takeProfit != null) {
      params.takeProfit = String(takeProfit);
    } else if (takeProfit === null) {
      params.takeProfit = "0";
    }
    const d = await bybitPrivate("POST", "/v5/position/set-trading-stop", params);
    if (d?.error === "Unexpected end of JSON input") {
      console.log(`[bybit] setTradingStop ${symbol} OK (empty body = success)`);
      return true;
    }
    if (d?.retCode !== 0) {
      console.error(`[bybit] setTradingStop ${symbol} retCode=${d?.retCode} msg=${d?.retMsg}`);
    }
    return d?.retCode === 0;
  } catch (e: any) {
    console.error(`[bybit] setTradingStop ${symbol} EXCEPCION:`, e);
    return false;
  }
}

export async function getRecentExecution(symbol: string): Promise<{ avgPrice: number; closedPnl: number } | null> {
  try {
    const d = await bybitPrivate("GET", "/v5/position/closed-pnl", {
      category: "linear", symbol, limit: 1,
    });
    const item = d?.result?.list?.[0];
    if (!item) return null;
    return {
      avgPrice: parseFloat(item.avgExitPrice || item.exitPrice || "0"),
      closedPnl: parseFloat(item.closedPnl || "0"),
    };
  } catch { return null; }
}

export async function getOpenPositions(): Promise<any[]> {
  try {
    const d = await bybitPrivate("GET", "/v5/position/list", {
      category: "linear", settleCoin: "USDT",
    });
    return (d?.result?.list ?? []).filter((p: any) => parseFloat(p.size) > 0);
  } catch { return []; }
}

/** Cancela todas las órdenes abiertas (limit/conditional) en la categoría linear.
 *  Esto libera el margen reservado por órdenes que no se ejecutaron. */
export async function cancelAllOpenOrders(): Promise<number> {
  try {
    const d = await bybitPrivate("POST", "/v5/order/cancel-all", {
      category: "linear", settleCoin: "USDT",
    });
    const cancelled = d?.result?.list?.length ?? 0;
    if (cancelled > 0) {
      console.log(`[bybit] cancelAllOpenOrders: ${cancelled} órdenes canceladas — margen liberado`);
      invalidateBalanceCache();
    }
    return cancelled;
  } catch (e) {
    console.error("[bybit] cancelAllOpenOrders error:", e);
    return 0;
  }
}
