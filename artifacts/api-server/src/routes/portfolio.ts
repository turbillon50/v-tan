import { Router } from "express";
import {
  GetBalanceResponse,
  GetPositionsResponse,
  GetTradesResponse,
  GetPortfolioStatsResponse,
} from "@workspace/api-zod";
import { bybitGet, hasCredentials } from "../lib/bybit-client";
import { getBybitBalance } from "../lib/bybit-auth";

const router = Router();

const ZERO_BALANCE = {
  totalEquity: 0,
  availableBalance: 0,
  unrealizedPnl: 0,
  totalWalletBalance: 0,
  demoMode: false,
};

// ─── Balance ──────────────────────────────────────────────────────────────────
router.get("/portfolio/balance", async (_req, res): Promise<void> => {
  if (!hasCredentials()) {
    res.json(GetBalanceResponse.parse(ZERO_BALANCE));
    return;
  }

  try {
    // Usar getBybitBalance() que maneja UNIFIED/SPOT/CONTRACT automáticamente
    // y parsea el campo coin.equity correctamente (no result.list[0].totalEquity)
    const bal = await getBybitBalance();
    if (!bal || bal.total <= 0) throw new Error("No balance data");

    // Pedir también el PnL no realizado de posiciones abiertas
    let unrealPnl = 0;
    try {
      const posResult = await bybitGet("/v5/position/list", { category: "linear", settleCoin: "USDT", limit: "50" });
      const positions = posResult?.list ?? [];
      unrealPnl = positions.reduce((sum: number, p: any) => sum + parseFloat(p.unrealisedPnl || "0"), 0);
    } catch { /* opcional */ }

    res.json(GetBalanceResponse.parse({
      totalEquity:        bal.equity,
      availableBalance:   bal.available,
      unrealizedPnl:      unrealPnl,
      totalWalletBalance: bal.total,
      demoMode: false,
    }));
  } catch {
    res.json(GetBalanceResponse.parse(ZERO_BALANCE));
  }
});

// ─── Positions ────────────────────────────────────────────────────────────────
router.get("/portfolio/positions", async (_req, res): Promise<void> => {
  if (!hasCredentials()) {
    res.json(GetPositionsResponse.parse([]));
    return;
  }

  try {
    const result = await bybitGet("/v5/position/list", {
      category:   "linear",
      settleCoin: "USDT",
      limit:      "50",
    });

    const positions = (result?.list ?? [])
      .filter((p: any) => parseFloat(p.size) > 0)
      .map((p: any) => ({
        symbol:               p.symbol,
        side:                 p.side === "Buy" ? "LONG" : "SHORT",
        size:                 parseFloat(p.size),
        entryPrice:           parseFloat(p.avgPrice),
        markPrice:            parseFloat(p.markPrice),
        leverage:             parseFloat(p.leverage),
        unrealizedPnl:        parseFloat(p.unrealisedPnl),
        unrealizedPnlPercent: parseFloat(p.unrealisedPnl) / (parseFloat(p.positionValue) || 1) * parseFloat(p.leverage) * 100,
        liquidationPrice:     parseFloat(p.liqPrice || "0"),
        stopLoss:             parseFloat(p.stopLoss || "0"),
        takeProfit:           parseFloat(p.takeProfit || "0"),
      }));

    res.json(GetPositionsResponse.parse(positions));
  } catch {
    res.json(GetPositionsResponse.parse([]));
  }
});

// ─── Trades ───────────────────────────────────────────────────────────────────
router.get("/portfolio/trades", async (_req, res): Promise<void> => {
  res.json(GetTradesResponse.parse([]));
});

// ─── Stats ────────────────────────────────────────────────────────────────────
router.get("/portfolio/stats", async (_req, res): Promise<void> => {
  res.json(GetPortfolioStatsResponse.parse({
    totalTrades:   0,
    winRate:       0,
    avgWin:        0,
    avgLoss:       0,
    profitFactor:  0,
    totalPnl:      0,
    bestTrade:     0,
    worstTrade:    0,
    currentStreak: 0,
  }));
});

export default router;
