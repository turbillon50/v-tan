import { Router } from "express";
import { GetCapitalGrowthResponse, CalculatePositionResponse } from "@workspace/api-zod";
import { bybitGet, hasCredentials } from "../lib/bybit-client";

const router = Router();

router.get("/capital/growth", async (_req, res): Promise<void> => {
  let currentCapital = 0;

  if (hasCredentials()) {
    try {
      const result = await bybitGet("/v5/account/wallet-balance", { accountType: "UNIFIED" });
      const acct = result?.list?.[0];
      if (acct) {
        currentCapital = parseFloat(acct.totalEquity ?? "0");
      }
    } catch {
      currentCapital = 0;
    }
  }

  res.json(GetCapitalGrowthResponse.parse({
    initialCapital:  parseFloat(currentCapital.toFixed(2)),
    currentCapital:  parseFloat(currentCapital.toFixed(2)),
    growthPercent:   0,
    history:         [],
    projection30d:   parseFloat((currentCapital * Math.pow(1.015, 30)).toFixed(2)),
    projection60d:   parseFloat((currentCapital * Math.pow(1.015, 60)).toFixed(2)),
    projection90d:   parseFloat((currentCapital * Math.pow(1.015, 90)).toFixed(2)),
    dailyReturn7d:   0,
  }));
});

router.post("/capital/calculator", async (req, res): Promise<void> => {
  const { symbol: _symbol, side, leverage, capitalPercent, entryPrice } = req.body as {
    symbol: string;
    side: "Buy" | "Sell";
    leverage: number;
    capitalPercent: number;
    entryPrice: number;
  };

  let totalCapital = 0;
  if (hasCredentials()) {
    try {
      const result = await bybitGet("/v5/account/wallet-balance", { accountType: "UNIFIED" });
      const acct = result?.list?.[0];
      if (acct) totalCapital = parseFloat(acct.totalEquity ?? "0");
    } catch { totalCapital = 0; }
  }

  const margin = (totalCapital * capitalPercent) / 100;
  const positionSize = margin * leverage;

  const isBuy = side === "Buy";
  const tp1Price = isBuy ? entryPrice * 1.03 : entryPrice * 0.97;
  const tp2Price = isBuy ? entryPrice * 1.07 : entryPrice * 0.93;
  const tp3Price = isBuy ? entryPrice * 1.15 : entryPrice * 0.85;
  const slPrice  = isBuy ? entryPrice * 0.98 : entryPrice * 1.02;
  const liqPrice = isBuy
    ? entryPrice * (1 - 1 / leverage + 0.005)
    : entryPrice * (1 + 1 / leverage - 0.005);

  const calc = (target: number) => {
    const pct = ((target - entryPrice) / entryPrice) * (isBuy ? 1 : -1);
    return parseFloat((positionSize * pct).toFixed(2));
  };

  res.json(CalculatePositionResponse.parse({
    positionSize:     parseFloat(positionSize.toFixed(2)),
    margin:           parseFloat(margin.toFixed(2)),
    tp1:              parseFloat(tp1Price.toFixed(4)),
    tp2:              parseFloat(tp2Price.toFixed(4)),
    tp3:              parseFloat(tp3Price.toFixed(4)),
    sl:               parseFloat(slPrice.toFixed(4)),
    pnlTp1:           calc(tp1Price),
    pnlTp2:           calc(tp2Price),
    pnlTp3:           calc(tp3Price),
    pnlSl:            calc(slPrice),
    liquidationPrice: parseFloat(liqPrice.toFixed(4)),
  }));
});

export default router;
