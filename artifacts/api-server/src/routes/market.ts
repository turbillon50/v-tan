import { Router } from "express";
import {
  GetTickerResponse,
  GetCandlesResponse,
  GetFundingRateResponse,
  GetOpenInterestResponse,
  GetMarketSentimentResponse,
} from "@workspace/api-zod";
import { generateCandles, getLivePrice, BASE_PRICES } from "../lib/demo-data";
import { logger } from "../lib/logger";
import { bybitPublic } from "../lib/bybit-auth";

const router = Router();

router.get("/market/ticker", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "BTCUSDT");
  if (!BASE_PRICES[symbol]) {
    res.status(400).json({ error: "Symbol not supported" });
    return;
  }

  let ticker;
  try {
    const data = await bybitPublic("GET", "/v5/market/tickers", { category: "linear", symbol });
    const t = data?.result?.list?.[0];
    if (t) {
      ticker = GetTickerResponse.parse({
        symbol,
        price: parseFloat(t.lastPrice),
        change24h: parseFloat(t.price24hPcnt) * parseFloat(t.prevPrice24h),
        changePercent24h: parseFloat(t.price24hPcnt) * 100,
        high24h: parseFloat(t.highPrice24h),
        low24h: parseFloat(t.lowPrice24h),
        volume24h: parseFloat(t.volume24h),
        markPrice: parseFloat(t.markPrice),
        indexPrice: parseFloat(t.indexPrice),
      });
    }
  } catch (err) {
    logger.debug({ err }, "Bybit ticker fetch failed, using demo");
  }

  if (!ticker) {
    const price = getLivePrice(symbol);
    const base = BASE_PRICES[symbol];
    ticker = GetTickerResponse.parse({
      symbol,
      price,
      change24h: price - base * 0.985,
      changePercent24h: ((price - base * 0.985) / (base * 0.985)) * 100,
      high24h: price * 1.018,
      low24h: price * 0.971,
      volume24h: base * 15000 + Math.random() * base * 3000,
      markPrice: price * 1.0001,
      indexPrice: price * 0.9999,
    });
  }

  res.json(ticker);
});

router.get("/market/candles", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "BTCUSDT");
  const interval = String(req.query.interval ?? "5");
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10), 200);

  let candles;
  try {
    const data = await bybitPublic("GET", "/v5/market/kline", { category: "linear", symbol, interval, limit: String(limit) });
    const list = data?.result?.list;
    if (Array.isArray(list) && list.length > 0) {
      candles = GetCandlesResponse.parse(
        list.reverse().map((c: string[]) => ({
          time: Math.floor(parseInt(c[0]) / 1000),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5]),
        }))
      );
    }
  } catch (err) {
    logger.debug({ err }, "Bybit candles fetch failed, using demo");
  }

  if (!candles) {
    candles = GetCandlesResponse.parse(generateCandles(symbol, parseInt(interval, 10), limit));
  }

  res.json(candles);
});

router.get("/market/funding-rate", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "BTCUSDT");

  let fundingRate;
  try {
    const data = await bybitPublic("GET", "/v5/market/tickers", { category: "linear", symbol });
    const t = data?.result?.list?.[0];
    if (t?.fundingRate) {
      fundingRate = GetFundingRateResponse.parse({
        symbol,
        rate: parseFloat(t.fundingRate) * 100,
        nextFundingTime: parseInt(t.nextFundingTime),
        predictedRate: parseFloat(t.fundingRate) * 100 * 0.95,
      });
    }
  } catch (err) {
    logger.debug({ err }, "Bybit funding rate fetch failed, using demo");
  }

  if (!fundingRate) {
    const nextHour = Math.ceil(Date.now() / 28800000) * 28800000;
    fundingRate = GetFundingRateResponse.parse({
      symbol,
      rate: 0.0082,
      nextFundingTime: nextHour,
      predictedRate: 0.0091,
    });
  }

  res.json(fundingRate);
});

router.get("/market/open-interest", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "BTCUSDT");

  let oi;
  try {
    const data = await bybitPublic("GET", "/v5/market/open-interest", { category: "linear", symbol, intervalTime: "5min", limit: "1" });
    const item = data?.result?.list?.[0];
    if (item) {
      const oiVal = parseFloat(item.openInterest);
      const price = BASE_PRICES[symbol] ?? 100;
      oi = GetOpenInterestResponse.parse({
        symbol,
        openInterest: oiVal,
        openInterestValue: oiVal * price,
      });
    }
  } catch (err) {
    logger.debug({ err }, "Bybit OI fetch failed, using demo");
  }

  if (!oi) {
    const price = BASE_PRICES[symbol] ?? 100;
    const baseOI = 50000 / price;
    oi = GetOpenInterestResponse.parse({
      symbol,
      openInterest: baseOI * (1 + (Math.random() - 0.5) * 0.1),
      openInterestValue: 50000 * (1 + (Math.random() - 0.5) * 0.1) * 1000,
    });
  }

  res.json(oi);
});

const TOP_OI_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT"];

interface OISummaryItem {
  symbol: string;
  coin: string;
  openInterest: number;
  openInterestValue: number;
  delta4h: number;
  arrow: "up" | "down" | "flat";
}

function buildOIItem(sym: string, delta4h: number, current: number): OISummaryItem {
  const price = BASE_PRICES[sym] ?? 1;
  return {
    symbol: sym,
    coin: sym.replace("USDT", ""),
    openInterest: current,
    openInterestValue: current * price,
    delta4h: parseFloat(delta4h.toFixed(2)),
    arrow: delta4h > 2 ? "up" : delta4h < -2 ? "down" : "flat",
  };
}

router.get("/market/oi-summary", async (_req, res): Promise<void> => {
  const results = await Promise.allSettled(
    TOP_OI_SYMBOLS.map(async (sym): Promise<OISummaryItem | null> => {
      try {
        const data = await bybitPublic("GET", "/v5/market/open-interest", {
          category: "linear",
          symbol: sym,
          intervalTime: "4h",
          limit: "2",
        });
        const list: { openInterest: string; timestamp: string }[] = data?.result?.list ?? [];
        if (list.length < 2) return null;
        const current = parseFloat(list[0].openInterest);
        const prev    = parseFloat(list[1].openInterest);
        if (isNaN(current) || isNaN(prev) || current <= 0) return null;
        const delta4h = prev > 0 ? ((current - prev) / prev) * 100 : 0;
        return buildOIItem(sym, delta4h, current);
      } catch {
        return null;
      }
    })
  );

  const symbols: OISummaryItem[] = results
    .filter((r): r is PromiseFulfilledResult<OISummaryItem> =>
      r.status === "fulfilled" && r.value !== null
    )
    .map(r => r.value);

  if (symbols.length === 0) {
    const demo: OISummaryItem[] = TOP_OI_SYMBOLS.slice(0, 6).map((sym) => {
      const price   = BASE_PRICES[sym] ?? 1;
      const baseOI  = 50000 / price;
      const noise   = (Math.random() - 0.5) * 0.08;
      const delta4h = parseFloat(((Math.random() - 0.5) * 6).toFixed(2));
      return buildOIItem(sym, delta4h, baseOI * (1 + noise));
    });
    res.json({ symbols: demo, updatedAt: Date.now(), demo: true });
    return;
  }

  res.json({ symbols, updatedAt: Date.now(), demo: false });
});

router.get("/market/sentiment", async (_req, res): Promise<void> => {
  let fearGreedIndex = 62;
  let fearGreedLabel = "Greed";

  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const data = await r.json() as any;
      if (data?.data?.[0]) {
        fearGreedIndex = parseInt(data.data[0].value);
        fearGreedLabel = data.data[0].value_classification;
      }
    }
  } catch {
    // use demo
  }

  const sentiment = GetMarketSentimentResponse.parse({
    fearGreedIndex,
    fearGreedLabel,
    btcDominance: 52.4 + (Math.random() - 0.5) * 2,
    totalMarketCap: 2.74e12 + (Math.random() - 0.5) * 0.1e12,
    whaleActivity: [
      { symbol: "BTCUSDT", amount: 2450000, type: "buy", time: Date.now() - 1800000 },
      { symbol: "ETHUSDT", amount: 1830000, type: "sell", time: Date.now() - 3600000 },
      { symbol: "SOLUSDT", amount: 1100000, type: "buy", time: Date.now() - 5400000 },
      { symbol: "BTCUSDT", amount: 3200000, type: "buy", time: Date.now() - 7200000 },
      { symbol: "XRPUSDT", amount: 1500000, type: "sell", time: Date.now() - 10800000 },
    ],
  });

  res.json(sentiment);
});

// ─── GET /market/orderbook ────────────────────────────────────────────────────
router.get("/market/orderbook", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "BTCUSDT");
  const limit  = 15;

  try {
    const data = await bybitPublic("GET", "/v5/market/orderbook", { category: "linear", symbol, limit: String(limit) });
    const ob = data?.result;
    if (ob?.b?.length && ob?.a?.length) {
      const bids = (ob.b as string[][]).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }));
      const asks = (ob.a as string[][]).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }));
      const totalBid = bids.reduce((acc, b) => acc + b.size, 0);
      const totalAsk = asks.reduce((acc, a) => acc + a.size, 0);
      res.json({ symbol, bids, asks, totalBid: parseFloat(totalBid.toFixed(4)), totalAsk: parseFloat(totalAsk.toFixed(4)), ratio: parseFloat((totalBid / totalAsk).toFixed(3)), updatedAt: Date.now() });
      return;
    }
  } catch { /* fallback */ }

  // Demo orderbook
  const base = BASE_PRICES[symbol] ?? 100;
  const bids = Array.from({ length: limit }, (_, i) => ({ price: parseFloat((base * (1 - 0.0005 * (i + 1))).toFixed(2)), size: parseFloat((Math.random() * 5 + 0.5).toFixed(3)) }));
  const asks = Array.from({ length: limit }, (_, i) => ({ price: parseFloat((base * (1 + 0.0005 * (i + 1))).toFixed(2)), size: parseFloat((Math.random() * 5 + 0.5).toFixed(3)) }));
  const totalBid = bids.reduce((a, b) => a + b.size, 0);
  const totalAsk = asks.reduce((a, b) => a + b.size, 0);
  res.json({ symbol, bids, asks, totalBid: parseFloat(totalBid.toFixed(4)), totalAsk: parseFloat(totalAsk.toFixed(4)), ratio: parseFloat((totalBid / totalAsk).toFixed(3)), updatedAt: Date.now() });
});

// ─── GET /market/sessions ─────────────────────────────────────────────────────
router.get("/market/sessions", (_req, res): void => {
  const h = new Date().getUTCHours();
  const m = new Date().getUTCMinutes();
  const t = h + m / 60;

  const sessions = [
    { name: "Asia",       open: 0,  close: 8,  emoji: "🌏", active: t >= 0 && t < 8 },
    { name: "Londres",    open: 7,  close: 16, emoji: "🌍", active: t >= 7 && t < 16 },
    { name: "New York",   open: 13, close: 22, emoji: "🗽", active: t >= 13 && t < 22 },
  ];

  const isOverlap = t >= 13 && t < 16;
  const current = isOverlap ? "Londres+NY Overlap 🔥"
    : sessions.find(s => s.active)?.name ?? "Pre-mercado";

  const nextOpen = sessions
    .map(s => ({ name: s.name, opensIn: s.open > t ? (s.open - t) : (24 - t + s.open) }))
    .sort((a, b) => a.opensIn - b.opensIn)[0];

  res.json({
    utcHour: h,
    utcMinute: m,
    current,
    isOverlap,
    sessions,
    nextSession: nextOpen,
    tip: isOverlap
      ? "⚡ Máxima liquidez. Las mejores señales del día ocurren en este horario."
      : current.includes("New York")
        ? "🗽 Alta liquidez. Movimientos fuertes especialmente en apertura."
        : current.includes("Londres")
          ? "🌍 Buena sesión para tendencias. Mayor actividad institucional."
          : current.includes("Asia")
            ? "🌏 Volatilidad moderada. Preferir BTC, BNB, DOGE."
            : "🌙 Volumen bajo. Señales menos confiables. Mejor esperar.",
  });
});

export default router;
