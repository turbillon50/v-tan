const express = require("express");
const crypto  = require("crypto");

const app    = express();
const PORT   = process.env.PORT || 3000;

const BYBIT_KEY    = process.env.BYBIT_API_KEY    || "";
const BYBIT_SECRET = process.env.BYBIT_API_SECRET  || "";
const PROXY_SECRET = process.env.PROXY_SECRET      || "";
const RECV_WINDOW  = "5000";
const BYBIT_BASE   = "https://api.bybit.com";

app.use(express.json());

// ─── Auth check ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const secret = req.headers["x-proxy-secret"] || req.body?.proxySecret;
  if (!PROXY_SECRET || secret !== PROXY_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Proxy ────────────────────────────────────────────────────────────────────
// POST /proxy  { method: "GET"|"POST", path: "/v5/...", params: {} }
app.post("/proxy", async (req, res) => {
  const { method = "GET", path, params = {} } = req.body;

  if (!path || !path.startsWith("/v5/")) {
    return res.status(400).json({ error: "Invalid path" });
  }

  try {
    const ts = Date.now().toString();
    let url     = `${BYBIT_BASE}${path}`;
    let body    = undefined;
    let payload = "";

    if (method === "GET") {
      const qs = new URLSearchParams(params).toString();
      payload  = qs;
      if (qs) url += `?${qs}`;
    } else {
      body    = JSON.stringify(params);
      payload = body;
    }

    const sig = crypto
      .createHmac("sha256", BYBIT_SECRET)
      .update(ts + BYBIT_KEY + RECV_WINDOW + payload)
      .digest("hex");

    const headers = {
      "Content-Type":        "application/json",
      "X-BAPI-API-KEY":      BYBIT_KEY,
      "X-BAPI-TIMESTAMP":    ts,
      "X-BAPI-SIGN":         sig,
      "X-BAPI-RECV-WINDOW":  RECV_WINDOW,
    };

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(10000),
    });

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e?.message || "Error conectando a Bybit" });
  }
});

app.listen(PORT, () => console.log(`🦈 Proxy Bybit escuchando en :${PORT}`));
