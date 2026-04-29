import { Router } from "express";
import { GetIndicatorsResponse } from "@workspace/api-zod";
import {
  generateCandles,
  calcRSI,
  calcEMA,
  calcMACD,
  calcBollingerBands,
  calcATR,
  calcCVD,
} from "../lib/demo-data";
import { logger } from "../lib/logger";
import { bybitPublic } from "../lib/bybit-auth";

const router = Router();

router.get("/indicators/:symbol", async (req, res): Promise<void> => {
  const raw = req.params.symbol;
  const symbol = Array.isArray(raw) ? raw[0] : raw;
  const interval = parseInt(String(req.query.interval ?? "5"), 10);

  let candles;
  try {
    const data = await bybitPublic("GET", "/v5/market/kline", { category: "linear", symbol, interval: String(interval), limit: "100" });
    const list = data?.result?.list;
    if (Array.isArray(list) && list.length > 0) {
      candles = list.reverse().map((c: string[]) => ({
        time: Math.floor(parseInt(c[0]) / 1000),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    }
  } catch (err) {
    logger.debug({ err }, "Bybit candles for indicators failed, using demo");
  }

  if (!candles) {
    candles = generateCandles(symbol, interval, 100);
  }

  const closes = candles.map((c: any) => c.close);
  const volumes = candles.map((c: any) => c.volume);

  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const bb = calcBollingerBands(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const atr = calcATR(candles);
  const cvd = calcCVD(candles);

  const avgVol = volumes.slice(-20).reduce((a: number, b: number) => a + b, 0) / 20;
  const curVol = volumes[volumes.length - 1] ?? avgVol;

  const result = GetIndicatorsResponse.parse({
    symbol,
    interval: String(interval),
    rsi: parseFloat(rsi.toFixed(2)),
    macd: {
      macd: parseFloat(macd.macd.toFixed(4)),
      signal: parseFloat(macd.signal.toFixed(4)),
      histogram: parseFloat(macd.histogram.toFixed(4)),
    },
    bollingerBands: {
      upper: parseFloat(bb.upper.toFixed(4)),
      middle: parseFloat(bb.middle.toFixed(4)),
      lower: parseFloat(bb.lower.toFixed(4)),
    },
    ema9: parseFloat(ema9.toFixed(4)),
    ema21: parseFloat(ema21.toFixed(4)),
    ema50: parseFloat(ema50.toFixed(4)),
    atr: parseFloat(atr.toFixed(4)),
    volume: {
      current: parseFloat(curVol.toFixed(2)),
      average: parseFloat(avgVol.toFixed(2)),
      ratio: parseFloat((curVol / avgVol).toFixed(2)),
    },
    cvd: parseFloat(cvd.toFixed(2)),
  });

  res.json(result);
});

export default router;
