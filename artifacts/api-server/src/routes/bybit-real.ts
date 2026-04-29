import { Router } from "express";
import { bybitPrivate, bybitPublic, getBybitBalance, getOpenPositions, calcQtyReal, setLeverage, placeMarketOrder, closePosition } from "../lib/bybit-auth";

const router = Router();

// ─── GET /bybit/test ─ Test API connection & credentials ─────────────────────
router.get("/test", async (_req, res): Promise<void> => {
  try {
    const raw = await bybitPrivate("GET", "/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: "USDT",
    });
    // Return raw response so we can debug exactly what Bybit says
    if (raw?.retCode === 0) {
      const coin = raw?.result?.list?.[0]?.coin?.find((c: any) => c.coin === "USDT");
      res.json({
        ok: true,
        balanceUSDT: parseFloat(coin?.walletBalance ?? "0"),
        availableUSDT: parseFloat(coin?.availableToWithdraw ?? coin?.walletBalance ?? "0"),
      });
    } else {
      res.json({ ok: false, retCode: raw?.retCode, retMsg: raw?.retMsg, raw });
    }
  } catch (e: any) {
    res.json({ ok: false, error: e?.message ?? "Error desconocido — posible bloqueo de red" });
  }
});

// ─── GET /bybit/balance ─ Full diagnostic across all account types ───────────
router.get("/balance", async (_req, res): Promise<void> => {
  // Query all accounts WITHOUT filtering by coin — ver todo lo que hay
  const accountTypes = ["UNIFIED", "SPOT", "CONTRACT"];
  const results = await Promise.all(
    accountTypes.map(accountType =>
      bybitPrivate("GET", "/v5/account/wallet-balance", { accountType })
        .then((d: any) => {
          const coins: any[] = d?.result?.list?.[0]?.coin ?? [];
          const nonZero = coins
            .map((c: any) => ({ coin: c.coin, balance: parseFloat(c.walletBalance ?? "0"), available: parseFloat(c.availableToWithdraw ?? c.walletBalance ?? "0") }))
            .filter(c => c.balance > 0);
          return { accountType, retCode: d?.retCode, coins: nonZero };
        })
        .catch(e => ({ accountType, retCode: -1, coins: [] as { coin: string; balance: number; available: number }[], error: e?.message }))
    )
  );

  // También intentar el endpoint de Funding account
  const fundRaw = await bybitPrivate("GET", "/v5/asset/transfer/query-account-coins-balance", { accountType: "FUND" })
    .then((d: any) => ({ coins: (d?.result?.balance ?? []).filter((c: any) => parseFloat(c.walletBalance ?? "0") > 0).map((c: any) => ({ coin: c.coin, balance: parseFloat(c.walletBalance ?? "0") })) }))
    .catch(() => ({ coins: [] }));

  // Encontrar el mejor balance USDT disponible
  let bestUsdt = 0;
  let bestAvailable = 0;
  for (const r of results) {
    const u = r.coins.find(c => c.coin === "USDT");
    if (u && u.balance > bestUsdt) { bestUsdt = u.balance; bestAvailable = u.available; }
  }

  res.json({
    available: bestUsdt > 0 ? bestAvailable : null,
    total: bestUsdt,
    accounts: results,
    funding: fundRaw.coins,
  });
});

// ─── GET /bybit/positions ─ Open positions ───────────────────────────────────
router.get("/positions", async (_req, res): Promise<void> => {
  const positions = await getOpenPositions();
  res.json({ positions });
});

// ─── POST /bybit/order ─ Place market order (manual/test) ────────────────────
router.post("/order", async (req, res): Promise<void> => {
  const { symbol, side, capitalUSDT, leverage } = req.body as {
    symbol: string; side: "Buy" | "Sell"; capitalUSDT: number; leverage: number;
  };
  try {
    // Fetch current price via proxy
    const priceData = await bybitPublic("GET", "/v5/market/tickers", { category: "linear", symbol });
    const price = parseFloat(priceData?.result?.list?.[0]?.lastPrice ?? "0");
    if (!price) { res.status(400).json({ error: "No se pudo obtener precio" }); return; }

    const qty = await calcQtyReal(symbol, capitalUSDT, leverage, price);
    if (!qty) { res.status(400).json({ error: "Cantidad mínima no alcanzada — aumenta el capital" }); return; }

    await setLeverage(symbol, leverage);
    const orderId = await placeMarketOrder(symbol, side, qty);
    if (!orderId) { res.status(502).json({ error: "Bybit rechazó la orden — revisa permisos y saldo" }); return; }

    res.json({ ok: true, orderId, symbol, side, qty, price, leverage });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Error al colocar orden" });
  }
});

// ─── POST /bybit/close ─ Close a position ────────────────────────────────────
router.post("/close", async (req, res): Promise<void> => {
  const { symbol, direction, qty } = req.body as { symbol: string; direction: "LONG" | "SHORT"; qty: string };
  const posIdx = direction === "LONG" ? 1 : 2;
  const ok = await closePosition(symbol, direction, qty, posIdx);
  res.json({ ok, symbol, direction, qty });
});

export default router;
