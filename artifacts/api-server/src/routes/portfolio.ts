import { Router } from "express";
import {
  GetBalanceResponse,
  GetPositionsResponse,
  GetTradesResponse,
  GetPortfolioStatsResponse,
} from "@workspace/api-zod";
import { bybitGet, hasCredentials } from "../lib/bybit-client";
import { getBybitBalance } from "../lib/bybit-auth";
import { db, tradeHistory } from "@workspace/db";
import { desc } from "drizzle-orm";

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
        // Bybit returns "Buy"/"Sell" — schema expects same. Don't translate to LONG/SHORT here.
        side:                 (p.side === "Buy" || p.side === "Sell") ? p.side : "Buy",
        size:                 parseFloat(p.size),
        entryPrice:           parseFloat(p.avgPrice || "0"),
        markPrice:            parseFloat(p.markPrice || "0"),
        leverage:             parseFloat(p.leverage || "1"),
        unrealizedPnl:        parseFloat(p.unrealisedPnl || "0"),
        unrealizedPnlPercent: parseFloat(p.unrealisedPnl || "0") / (parseFloat(p.positionValue || "0") || 1) * parseFloat(p.leverage || "1") * 100,
        liquidationPrice:     parseFloat(p.liqPrice || "0"),
        stopLoss:             parseFloat(p.stopLoss || "0"),
        takeProfit1:          parseFloat(p.takeProfit || "0"),
        takeProfit2:          0,
        takeProfit3:          0,
        openedAt:             parseInt(p.createdTime || p.updatedTime || "0", 10),
      }));

    res.json(GetPositionsResponse.parse(positions));
  } catch (err) {
    console.warn("[portfolio/positions] error:", (err as Error).message);
    res.json(GetPositionsResponse.parse([]));
  }
});

// ─── Trades ───────────────────────────────────────────────────────────────────
router.get("/portfolio/trades", async (req, res): Promise<void> => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
    // Trades cerrados ordenados por closed_at DESC — el más reciente primero.
    // (Antes ordenaba por opened_at, que para una orden con vela larga ponía
    // primero el opened pero el cierre podía ser anterior al de otra orden.)
    const rows = await db
      .select()
      .from(tradeHistory)
      .orderBy(desc(tradeHistory.closedAt))
      .limit(limit);

    const trades = rows.map((r) => {
      const entry = parseFloat(r.entryPrice ?? "0");
      const exit  = parseFloat(r.exitPrice ?? "0");
      const pnl   = parseFloat(r.netPnl ?? "0");
      const qty   = parseFloat(r.qty ?? "0");
      const lev   = r.leverage ?? 1;
      const notional = entry * qty;
      const pnlPercent = notional > 0 ? (pnl / notional) * 100 : 0;
      const opened = r.openedAt ? new Date(r.openedAt).getTime() : 0;
      const closed = r.closedAt ? new Date(r.closedAt).getTime() : opened;
      const duration = Math.max(0, Math.round((closed - opened) / 60000)); // minutes
      const side: "Buy" | "Sell" = (r.side === "LONG" || r.side === "Buy") ? "Buy" : "Sell";
      const riskMode: "conservative" | "risky" | "ultra" =
        lev <= 5 ? "conservative" : lev <= 15 ? "risky" : "ultra";
      return {
        id: String(r.id),
        symbol: r.symbol,
        side,
        size: qty,
        entryPrice: entry,
        exitPrice: exit,
        pnl,
        pnlPercent,
        leverage: lev,
        duration,
        closedAt: closed,
        riskMode,
      };
    });

    res.json(GetTradesResponse.parse(trades));
  } catch (err) {
    console.warn("[portfolio/trades] error:", (err as Error).message);
    res.json(GetTradesResponse.parse([]));
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
router.get("/portfolio/stats", async (_req, res): Promise<void> => {
  try {
    const rows = await db
      .select()
      .from(tradeHistory)
      .orderBy(desc(tradeHistory.openedAt))
      .limit(500);

    if (rows.length === 0) {
      res.json(GetPortfolioStatsResponse.parse({
        totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0,
        profitFactor: 0, totalPnl: 0, bestTrade: 0, worstTrade: 0, currentStreak: 0,
      }));
      return;
    }

    const pnls = rows.map((r) => parseFloat(r.netPnl ?? "0"));
    const totalTrades = pnls.length;
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p <= 0);
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const totalWins  = wins.reduce((a, b) => a + b, 0);
    const totalLosses = Math.abs(losses.reduce((a, b) => a + b, 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : (totalWins > 0 ? 999 : 0);
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const bestTrade = pnls.length > 0 ? Math.max(...pnls) : 0;
    const worstTrade = pnls.length > 0 ? Math.min(...pnls) : 0;

    // Current streak: count consecutive (most recent) trades of same sign
    let currentStreak = 0;
    if (pnls.length > 0) {
      const firstSign = Math.sign(pnls[0]);
      for (const p of pnls) {
        if (Math.sign(p) === firstSign) currentStreak++;
        else break;
      }
      if (firstSign < 0) currentStreak = -currentStreak;
    }

    res.json(GetPortfolioStatsResponse.parse({
      totalTrades,
      winRate: parseFloat(winRate.toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(4)),
      avgLoss: parseFloat(avgLoss.toFixed(4)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      totalPnl: parseFloat(totalPnl.toFixed(4)),
      bestTrade: parseFloat(bestTrade.toFixed(4)),
      worstTrade: parseFloat(worstTrade.toFixed(4)),
      currentStreak,
    }));
  } catch (err) {
    console.warn("[portfolio/stats] error:", (err as Error).message);
    res.json(GetPortfolioStatsResponse.parse({
      totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0,
      profitFactor: 0, totalPnl: 0, bestTrade: 0, worstTrade: 0, currentStreak: 0,
    }));
  }
});

export default router;
