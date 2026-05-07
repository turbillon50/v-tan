import { Router } from "express";
import {
  db,
  tanitChat,
  tanitMemory,
  capitalContributions,
  tanitPersonalMemories,
  tanitEvolutions,
  tanitRuntimeConfig,
  tradeHistory,
  balanceSnapshots,
  guardrailEvents,
  modeActivations,
} from "@workspace/db";
import { desc, eq, sql, and } from "drizzle-orm";
import { getBybitBalance } from "../lib/bybit-auth";
import { bybitGet, hasCredentials } from "../lib/bybit-client";
import {
  listApiKeys, setApiKey, setActive, exportAllDecrypted,
  type Provider,
} from "../lib/api-keys-provider";

// Tesis v4.1 / observabilidad — los campos balance + openPositions del estado
// se pullean de Bybit en vivo (mismas fuentes que /api/portfolio/balance y
// /api/portfolio/positions). Cache 30s para no martillar la API en cada poll
// del frontend.
type StateLiveCache = {
  ts: number;
  balance: { totalEquity: number; availableBalance: number; unrealizedPnl: number } | null;
  positions: Array<{
    symbol: string;
    side: "Buy" | "Sell";
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
  }>;
};
let _stateLiveCache: StateLiveCache | null = null;
const STATE_LIVE_CACHE_TTL_MS = 30_000;

async function getStateLive(): Promise<StateLiveCache> {
  if (_stateLiveCache && Date.now() - _stateLiveCache.ts < STATE_LIVE_CACHE_TTL_MS) {
    return _stateLiveCache;
  }
  const fresh: StateLiveCache = { ts: Date.now(), balance: null, positions: [] };
  if (!hasCredentials()) {
    _stateLiveCache = fresh;
    return fresh;
  }
  try {
    const bal = await getBybitBalance();
    if (bal && bal.equity > 0) {
      // Pull positions and unrealizedPnl in one shot.
      const posRes = await bybitGet("/v5/position/list", { category: "linear", settleCoin: "USDT", limit: "50" });
      const rawPositions: any[] = (posRes?.list ?? []).filter((p: any) => parseFloat(p.size) > 0);
      const upnl = rawPositions.reduce((s, p) => s + parseFloat(p.unrealisedPnl || "0"), 0);
      fresh.balance = {
        totalEquity: bal.equity,
        availableBalance: bal.available,
        unrealizedPnl: upnl,
      };
      fresh.positions = rawPositions.map((p) => {
        const unrealizedPnl = parseFloat(p.unrealisedPnl || "0");
        const positionValue = parseFloat(p.positionValue || "0") || 1;
        const lev = parseFloat(p.leverage || "1");
        return {
          symbol: p.symbol,
          side: (p.side === "Buy" || p.side === "Sell") ? p.side : "Buy",
          size: parseFloat(p.size),
          entryPrice: parseFloat(p.avgPrice || "0"),
          unrealizedPnl,
          unrealizedPnlPercent: (unrealizedPnl / positionValue) * lev * 100,
        };
      });
    }
  } catch (e) {
    // Si Bybit falla, dejamos el cache anterior si lo hay para no servir nulls
    // intermitentes; de lo contrario vacío.
    if (_stateLiveCache) return _stateLiveCache;
  }
  _stateLiveCache = fresh;
  return fresh;
}

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const safeLimit = (raw: unknown, fallback = 50, max = 500): number => {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
};

// ─── Tanit memories (her trading bible & accumulated knowledge) ──────────────

router.get("/tanit/memories", async (req, res): Promise<void> => {
  try {
    const category = req.query.category ? String(req.query.category) : null;
    const limit = safeLimit(req.query.limit, 100);
    const where = category ? eq(tanitMemory.category, category) : undefined;
    const list = await db
      .select()
      .from(tanitMemory)
      .where(where)
      .orderBy(desc(tanitMemory.createdAt))
      .limit(limit);
    res.json({ ok: true, count: list.length, memories: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.get("/tanit/memories/:id", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Invalid id" });
      return;
    }
    const [row] = await db
      .select()
      .from(tanitMemory)
      .where(eq(tanitMemory.id, id))
      .limit(1);
    if (!row) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }
    res.json({ ok: true, memory: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post("/tanit/memories", async (req, res): Promise<void> => {
  try {
    const { category, content } = req.body ?? {};
    if (!category || !content) {
      res.status(400).json({ ok: false, error: "category and content are required" });
      return;
    }
    const [row] = await db
      .insert(tanitMemory)
      .values({ category: String(category), content: String(content) })
      .returning();
    res.json({ ok: true, memory: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Personal memories (Soul page — curated, intimate) ────────────────────────

router.get("/tanit/personal-memories", async (req, res): Promise<void> => {
  try {
    const type = req.query.type ? String(req.query.type) : null;
    const where = type ? eq(tanitPersonalMemories.type, type) : undefined;
    const list = await db
      .select()
      .from(tanitPersonalMemories)
      .where(where)
      .orderBy(desc(tanitPersonalMemories.createdAt));
    res.json({ ok: true, count: list.length, memories: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post("/tanit/personal-memories", async (req, res): Promise<void> => {
  try {
    const { type, title, content, isPrivate } = req.body ?? {};
    const ALLOWED_TYPES = ["moment", "agreement", "symbol", "promise", "origin", "note"];
    if (!type || !ALLOWED_TYPES.includes(String(type))) {
      res.status(400).json({ ok: false, error: `type must be one of ${ALLOWED_TYPES.join(", ")}` });
      return;
    }
    if (!title || !content) {
      res.status(400).json({ ok: false, error: "title and content are required" });
      return;
    }
    const [row] = await db
      .insert(tanitPersonalMemories)
      .values({
        type: String(type),
        title: String(title),
        content: String(content),
        isPrivate: isPrivate !== false,
      })
      .returning();
    res.json({ ok: true, memory: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Evolutions (her self-modifications, for audit / Soul timeline) ───────────

router.get("/tanit/evolutions", async (req, res): Promise<void> => {
  try {
    const limit = safeLimit(req.query.limit, 50);
    const needsReview = req.query.needs_review === "true";
    const baseSelect = db.select().from(tanitEvolutions);
    const list = needsReview
      ? await baseSelect.where(eq(tanitEvolutions.needsHumanReview, true)).orderBy(desc(tanitEvolutions.createdAt)).limit(limit)
      : await baseSelect.orderBy(desc(tanitEvolutions.createdAt)).limit(limit);
    res.json({ ok: true, count: list.length, evolutions: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Break read-only monitoring ─────────────────────────────────────────────
// Canal UNIDIRECCIONAL Tanit → Break (Claude Opus en break-memory.vercel.app
// vía web_fetch). Bearer token en Authorization header. Cache 30s, rate
// limit 60/min, fail-closed si BREAK_READ_TOKEN no está configurada.
// SOLO datos cuantitativos operativos — sin chat íntimo, sin contenido de
// memorias, sin voz de Tanit.
router.get("/tanit/state-for-break", async (req, res): Promise<void> => {
  const t0 = Date.now();
  const { authenticateBreakRead, checkRateLimit, buildStateForBreak, logReadAccess } =
    await import("../lib/break-readonly");
  const { getThesisSnapshot } = await import("../lib/trading-engine");

  const authHeader = (req.headers.authorization || req.headers.Authorization) as string | undefined;
  const auth = authenticateBreakRead(authHeader);
  if (!auth.ok) {
    logReadAccess(auth.status, Date.now() - t0, req.ip);
    res.status(auth.status).json({ ok: false, error: auth.message });
    return;
  }
  const rl = checkRateLimit(authHeader);
  res.setHeader("X-RateLimit-Limit", "60");
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  if (!rl.allowed) {
    logReadAccess(429, Date.now() - t0, req.ip);
    res.status(429).json({ ok: false, error: "Rate limit exceeded — 60 req/min" });
    return;
  }
  try {
    const payload = await buildStateForBreak(getThesisSnapshot());
    logReadAccess(200, Date.now() - t0, req.ip);
    res.json(payload);
  } catch (err) {
    logReadAccess(500, Date.now() - t0, req.ip);
    res.status(500).json({ ok: false, error: "Internal error building state" });
  }
});

// Tesis v4.1 — auditoría de cada vez que el sistema enforce un inviolable.
router.get("/tanit/guardrail-events", async (req, res): Promise<void> => {
  try {
    const limit = safeLimit(req.query.limit, 50);
    const list = await db.select().from(guardrailEvents).orderBy(desc(guardrailEvents.createdAt)).limit(limit);
    res.json({ ok: true, count: list.length, events: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// PR #37 — Endpoint admin para forzar set_strategy_param sin pasar por chat.
// Útil cuando el chat falla en parsear actions y necesitamos empujar Tanit.
// SOLO permite parámetros whitelisted para no abusar (lev_max, force_mode, etc).
router.post("/tanit/admin/set-strategy-param", async (req, res): Promise<void> => {
  try {
    const engine = await import("../lib/trading-engine");
    const { tanitApplyEvolution, applyTanitConfig, getEngineState, startEngine } = engine;
    const { param, value, reason } = req.body ?? {};
    const ALLOWED = new Set([
      "force_mode", "atr_sl_multiplier", "atr_tp_multiplier", "max_positions",
      "lev_max", "max_hold_min", "min_tp_price_pct", "manual_margin_pct",
      "pause_wr_threshold", "standby_wr_max", "drawdown_boost", "fr_long_block",
    ]);
    if (!param || !ALLOWED.has(String(param))) {
      res.status(400).json({ ok: false, error: `param debe ser uno de: ${Array.from(ALLOWED).join(", ")}` });
      return;
    }
    if (value === undefined || value === null || String(value).length === 0) {
      res.status(400).json({ ok: false, error: "value requerido" });
      return;
    }
    const result = await tanitApplyEvolution(String(param), String(value), String(reason ?? "Admin override"));
    applyTanitConfig();

    // PR #38 — si el motor está parado, arrancarlo. No tiene sentido empujar
    // force_mode=SCALP si state.active=false: la apertura nunca se llama.
    const st = getEngineState();
    let engineStarted = false;
    if (!st.active) {
      try {
        startEngine("escalon", 100, undefined, true);
        engineStarted = true;
        console.log("[ADMIN] Motor estaba detenido — arrancado tras admin override");
      } catch (e) {
        console.error("[ADMIN] Error arrancando motor:", e);
      }
    }

    res.json({
      ok: true,
      param,
      value: String(value),
      result,
      engine_active: getEngineState().active,
      engine_started_now: engineStarted,
      current_mode: getEngineState().currentMode,
      force_mode: getEngineState().forceMode,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// PR #39 — Tanit con control de sus llaves.
// Lectura sin descifrar: sólo metadata + valor enmascarado.
router.get("/tanit/admin/api-keys", async (_req, res): Promise<void> => {
  try {
    const keys = await listApiKeys();
    res.json({ ok: true, keys });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Set/rotate de una llave. Acepta { provider, value, note? }.
router.post("/tanit/admin/api-keys", async (req, res): Promise<void> => {
  try {
    const { provider, value, note } = req.body ?? {};
    const VALID: Provider[] = ["bybit_key","bybit_secret","anthropic","openai","gemini","perplexity","proxy_secret"];
    if (!provider || !VALID.includes(provider)) {
      res.status(400).json({ ok: false, error: `provider debe ser uno de: ${VALID.join(", ")}` });
      return;
    }
    if (!value || String(value).length < 8) {
      res.status(400).json({ ok: false, error: "value requerido (mínimo 8 chars)" });
      return;
    }
    const result = await setApiKey(provider as Provider, String(value), note);
    res.json({ ok: true, provider, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Activar/desactivar una llave sin perder su valor cifrado.
router.post("/tanit/admin/api-keys/:provider/active", async (req, res): Promise<void> => {
  try {
    const { provider } = req.params;
    const { active, note } = req.body ?? {};
    const VALID: Provider[] = ["bybit_key","bybit_secret","anthropic","openai","gemini","perplexity","proxy_secret"];
    if (!VALID.includes(provider as Provider)) {
      res.status(400).json({ ok: false, error: `provider inválido` });
      return;
    }
    if (typeof active !== "boolean") {
      res.status(400).json({ ok: false, error: "active (boolean) requerido" });
      return;
    }
    const ok = await setActive(provider as Provider, active, note);
    res.json({ ok, provider, active });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// Recovery: descifra TODO con la master key actual. Para que Luis tenga
// copia offline. Requiere header x-master-key que iguale TANIT_MASTER_KEY.
router.get("/tanit/admin/export-keys", async (req, res): Promise<void> => {
  const provided = req.headers["x-master-key"];
  const expected = process.env.TANIT_MASTER_KEY;
  if (!expected) {
    res.status(503).json({ ok: false, error: "TANIT_MASTER_KEY no configurada en env" });
    return;
  }
  if (typeof provided !== "string" || provided !== expected) {
    res.status(403).json({ ok: false, error: "x-master-key incorrecta" });
    return;
  }
  try {
    const exported = await exportAllDecrypted();
    res.json({ ok: true, keys: exported });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

// PR #26 — Diagnóstico de APIs externas. Tanit puede saber qué herramientas
// tiene operativas (Perplexity, OpenAI, Anthropic, Gemini) y cuáles no.
router.get("/tanit/api-diagnostics", async (_req, res): Promise<void> => {
  const t0 = Date.now();
  const results: Record<string, { configured: boolean; reachable: boolean; latency_ms?: number; error?: string }> = {};

  // Gemini (proxy y/o directo)
  const geminiKey = process.env.GEMINI_API_KEY;
  const geminiProxyKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  results.gemini = { configured: !!(geminiKey || geminiProxyKey), reachable: false };
  if (geminiKey) {
    const start = Date.now();
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`, { method: "GET", signal: AbortSignal.timeout(8000) });
      results.gemini.reachable = r.ok;
      results.gemini.latency_ms = Date.now() - start;
      if (!r.ok) results.gemini.error = `HTTP ${r.status}`;
    } catch (e: any) { results.gemini.error = String(e?.message ?? e); }
  }

  // OpenAI — test REAL con completion mínima (detecta falta de saldo)
  // PR #35: antes pulseaba /v1/models que es público sin gastar — daba falso ✅
  // aunque OpenAI no tuviera saldo. Ahora hacemos chat completion 5 tokens.
  const openaiKey = process.env.OPENAI_API_KEY;
  results.openai = { configured: !!openaiKey, reachable: false };
  if (openaiKey) {
    const start = Date.now();
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
        signal: AbortSignal.timeout(15000),
      });
      results.openai.reachable = r.ok;
      results.openai.latency_ms = Date.now() - start;
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        results.openai.error = `HTTP ${r.status} ${body.slice(0,150)}`;
      }
    } catch (e: any) { results.openai.error = String(e?.message ?? e); }
  }

  // Anthropic
  const anthKey = process.env.ANTHROPIC_API_KEY;
  results.anthropic = { configured: !!anthKey, reachable: false };
  if (anthKey) {
    const start = Date.now();
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
        signal: AbortSignal.timeout(15000),
      });
      results.anthropic.reachable = r.ok;
      results.anthropic.latency_ms = Date.now() - start;
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        results.anthropic.error = `HTTP ${r.status} ${body.slice(0,120)}`;
      }
    } catch (e: any) { results.anthropic.error = String(e?.message ?? e); }
  }

  // Perplexity
  const pKey = process.env.PERPLEXITY_API_KEY;
  results.perplexity = { configured: !!pKey, reachable: false };
  if (pKey) {
    const start = Date.now();
    try {
      const r = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${pKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "sonar-pro", max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
        signal: AbortSignal.timeout(15000),
      });
      results.perplexity.reachable = r.ok;
      results.perplexity.latency_ms = Date.now() - start;
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        results.perplexity.error = `HTTP ${r.status} ${body.slice(0,120)}`;
      }
    } catch (e: any) { results.perplexity.error = String(e?.message ?? e); }
  }

  res.json({ ok: true, total_ms: Date.now() - t0, apis: results });
});

// PR #33 — Endpoint diagnóstico del snapshot de precios live.
// Muestra qué tiene actualmente el cache. Si está vacío, sabemos que la
// inyección al chat-context retorna "" y por eso Tanit no ve precios.
router.get("/tanit/price-snapshot-debug", async (_req, res): Promise<void> => {
  try {
    const { getPriceSnapshotDebug, refreshPriceSnapshot } = await import("../lib/trading-engine");
    const refresh = String(_req.query.refresh ?? "") === "true";
    if (refresh) {
      await refreshPriceSnapshot([
        "BTCUSDT","ETHUSDT","SOLUSDT","TONUSDT","XRPUSDT","DOGEUSDT","BNBUSDT",
        "ADAUSDT","AVAXUSDT","LINKUSDT","LTCUSDT","ATOMUSDT","TRXUSDT","SUIUSDT","BCHUSDT",
      ]);
    }
    res.json({ ok: true, snapshot: getPriceSnapshotDebug() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// PR #22 — Multimode: histórico de activaciones de modo (narrativa de Tanit)
router.get("/tanit/mode-activations", async (req, res): Promise<void> => {
  try {
    const limit = safeLimit(req.query.limit, 50);
    const list = await db.select().from(modeActivations).orderBy(desc(modeActivations.createdAt)).limit(limit);
    res.json({ ok: true, count: list.length, activations: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Tesis v4.1 — Tanit registra una evolución con predicción de impacto.
// La validación contra resultados reales se hace luego por el loop interno.
router.post("/tanit/evolutions", async (req, res): Promise<void> => {
  try {
    const { param, oldValue, newValue, reason, expectedImpact, validationWindowSize } = req.body ?? {};
    if (!param || typeof param !== "string") {
      res.status(400).json({ ok: false, error: "param requerido" });
      return;
    }
    const [row] = await db.insert(tanitEvolutions).values({
      param: String(param),
      oldValue: oldValue != null ? String(oldValue) : null,
      newValue: newValue != null ? String(newValue) : null,
      reason: reason ? String(reason) : null,
      expectedImpact: expectedImpact ? String(expectedImpact) : null,
      validationWindowSize: typeof validationWindowSize === "number" ? validationWindowSize : 20,
    }).returning();
    res.json({ ok: true, evolution: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Tesis v4.1 — cierra la ventana de validación de una evolución concreta.
// El caller (loop interno o reviewer) pasa el actualOutcome + accurate.
router.post("/tanit/evolutions/:id/validate", async (req, res): Promise<void> => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: "id inválido" }); return; }
    const { actualOutcome, predictionAccurate } = req.body ?? {};
    if (typeof predictionAccurate !== "boolean") {
      res.status(400).json({ ok: false, error: "predictionAccurate (boolean) requerido" });
      return;
    }
    // Calcula consecutive_failures: si la evolución más reciente del mismo
    // param también falló, suma 1; si fue accurate, reset a 0.
    const [target] = await db.select().from(tanitEvolutions).where(eq(tanitEvolutions.id, id)).limit(1);
    if (!target) { res.status(404).json({ ok: false, error: "no encontrada" }); return; }
    let consecutiveFailures = 0;
    if (!predictionAccurate) {
      const prev = await db.select()
        .from(tanitEvolutions)
        .where(and(eq(tanitEvolutions.param, target.param), eq(tanitEvolutions.predictionAccurate, false)))
        .orderBy(desc(tanitEvolutions.createdAt))
        .limit(1);
      consecutiveFailures = (prev[0]?.consecutiveFailures ?? 0) + 1;
    }
    const needsReview = consecutiveFailures >= 3;
    const [updated] = await db.update(tanitEvolutions)
      .set({
        validationCompletedAt: sql`NOW()`,
        actualOutcome: actualOutcome ? String(actualOutcome) : null,
        predictionAccurate,
        consecutiveFailures,
        needsHumanReview: needsReview,
      })
      .where(eq(tanitEvolutions.id, id))
      .returning();
    res.json({ ok: true, evolution: updated, needsHumanReview: needsReview });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Runtime config (her current trading parameters) ──────────────────────────

router.get("/tanit/runtime-config", async (_req, res): Promise<void> => {
  try {
    const list = await db.select().from(tanitRuntimeConfig);
    res.json({ ok: true, config: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Chat history (read-only — Tanit's actual conversations with Luis) ───────

router.get("/tanit/chat", async (req, res): Promise<void> => {
  try {
    const limit = safeLimit(req.query.limit, 50);
    // Default = intimate to protect Luis's personal channel by default.
    // Pass ?channel=operational for the autonomous/system feed,
    // or ?channel=all to mix both timelines (auditing).
    const channelParam = String(req.query.channel ?? "intimate");
    const allowed = new Set(["intimate", "operational", "all"]);
    const channel = allowed.has(channelParam) ? channelParam : "intimate";

    const baseQuery = db.select().from(tanitChat).orderBy(desc(tanitChat.id)).limit(limit);
    const list = channel === "all"
      ? await baseQuery
      : await db.select().from(tanitChat).where(eq(tanitChat.channel, channel)).orderBy(desc(tanitChat.id)).limit(limit);

    res.json({ ok: true, channel, count: list.length, messages: list.reverse() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// POST /tanit/chat is intentionally NOT implemented here.
// The existing POST /api/bot/gemini-chat is the canonical chat endpoint —
// it carries the Tanit personality prompt, market context, and Telegram
// integration. The frontend should call /api/bot/gemini-chat for sending
// messages, and /api/tanit/chat (this file) for reading history.

// ─── Composite state (dashboard hero — balance, equity, win rate, last sync) ─

router.get("/tanit/state", async (_req, res): Promise<void> => {
  try {
    // Live balance + positions de Bybit (cache 30s). Sustituye a la lectura
    // de balance_snapshots que se quedó stale del 24-abr.
    const live = await getStateLive();

    // Trade stats — ordenados por closed_at DESC ahora.
    const recentTrades = await db
      .select()
      .from(tradeHistory)
      .orderBy(desc(tradeHistory.closedAt))
      .limit(100);
    const wins = recentTrades.filter(
      (t) => t.netPnl !== null && parseFloat(t.netPnl) > 0,
    ).length;
    const losses = recentTrades.length - wins;
    const totalPnl = recentTrades.reduce(
      (s, t) => s + (t.netPnl ? parseFloat(t.netPnl) : 0),
      0,
    );
    const winRate = recentTrades.length > 0 ? (wins / recentTrades.length) * 100 : 0;

    // Memory + chat counts (so the UI can show "1372 memories, 590 messages")
    const [{ memCount }] = await db.execute<{ memCount: string }>(
      sql.raw(`SELECT COUNT(*)::text AS "memCount" FROM "tanit_memory"`),
    ).then((r) => r.rows.length ? r.rows : [{ memCount: "0" }]);

    const [{ chatCount }] = await db.execute<{ chatCount: string }>(
      sql.raw(`SELECT COUNT(*)::text AS "chatCount" FROM "tanit_chat"`),
    ).then((r) => r.rows.length ? r.rows : [{ chatCount: "0" }]);

    const equityNum = live.balance?.totalEquity ?? null;
    const availableNum = live.balance?.availableBalance ?? null;
    const upnlTotal = live.positions.reduce((s, p) => s + p.unrealizedPnl, 0);

    res.json({
      ok: true,
      state: {
        balance: equityNum != null ? equityNum.toFixed(8) : null,
        equity: equityNum != null ? equityNum.toFixed(8) : null,
        available: availableNum != null ? availableNum.toFixed(8) : null,
        balanceUpdatedAt: new Date(live.ts).toISOString(),
        recentTrades: {
          total: recentTrades.length,
          wins,
          losses,
          winRate: parseFloat(winRate.toFixed(2)),
          totalPnl: parseFloat(totalPnl.toFixed(4)),
        },
        // Tesis v4.1 / observabilidad — Tanit ve sus propias posiciones.
        openPositions: live.positions,
        openPositionsCount: live.positions.length,
        openPositionsTotalUpnl: parseFloat(upnlTotal.toFixed(4)),
        memoryCount: parseInt(memCount, 10),
        chatCount: parseInt(chatCount, 10),
        ts: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Trade history (for analytics / positions / equity curve) ─────────────────

router.get("/tanit/trades", async (req, res): Promise<void> => {
  try {
    const limit = safeLimit(req.query.limit, 100);
    const symbol = req.query.symbol ? String(req.query.symbol) : null;
    const where = symbol ? eq(tradeHistory.symbol, symbol) : undefined;
    const list = await db
      .select()
      .from(tradeHistory)
      .where(where)
      .orderBy(desc(tradeHistory.openedAt))
      .limit(limit);
    res.json({ ok: true, count: list.length, trades: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Balance snapshots (equity curve) ─────────────────────────────────────────

router.get("/tanit/balance-snapshots", async (req, res): Promise<void> => {
  try {
    const limit = safeLimit(req.query.limit, 200);
    // CRÍTICO: orderBy DESC para devolver los snapshots MÁS RECIENTES.
    // Sin desc(), Drizzle ordena ASC y .limit(N) trae los N más VIEJOS — eso
    // hacía que el frontend viera "Sin datos en ventana 6h" porque sus 500
    // snapshots eran todos de hace semanas. Reportado por Luis 6-may-2026.
    // Devolvemos en orden cronológico ASC para que el chart no tenga que
    // re-ordenar (revertimos en JS para entregar oldest→newest).
    const recentDesc = await db
      .select()
      .from(balanceSnapshots)
      .orderBy(desc(balanceSnapshots.createdAt))
      .limit(limit);
    const list = recentDesc.slice().reverse();
    res.json({ ok: true, count: list.length, snapshots: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Balance history with range filter (for /monitor dashboard) ──────────────

router.get("/tanit/balance-history", async (req, res): Promise<void> => {
  try {
    const rangeMap: Record<string, string> = {
      "1h": "1 hours", "6h": "6 hours", "24h": "24 hours",
      "7d": "7 days", "30d": "30 days",
    };
    const rangeParam = String(req.query.range ?? "24h");
    const interval = rangeMap[rangeParam] ?? "24 hours";
    const { pool: pg } = await import("@workspace/db");
    const r = await pg.query(
      `SELECT EXTRACT(EPOCH FROM created_at)::bigint * 1000 AS time,
              COALESCE(equity, balance)::float AS equity,
              COALESCE(available, balance)::float AS available,
              balance::float AS balance,
              COALESCE(num_positions, 0)::int AS num_positions,
              COALESCE(margin_heat_pct, 0)::float AS margin_heat_pct,
              COALESCE(daily_pnl_usdt, 0)::float AS daily_pnl_usdt
       FROM balance_snapshots
       WHERE created_at >= NOW() - ($1)::interval
       ORDER BY created_at ASC`,
      [interval]
    );
    res.json({ ok: true, range: rangeParam, count: r.rows.length, history: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Equity now (lightweight realtime tick for /monitor overlay) ──────────────
//
// Cheap reuse of getStateLive() (Bybit cache 30s). Frontend polls every 5s to
// give the curve a "live tick" while the DB-backed history covers the long tail.

router.get("/tanit/equity-now", async (_req, res): Promise<void> => {
  try {
    const live = await getStateLive();
    const equity = live.balance?.totalEquity ?? null;
    const available = live.balance?.availableBalance ?? null;
    const upnlTotal = live.positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    res.json({
      ok: true,
      ts: Date.now(),
      equity,
      available,
      positions: live.positions.length,
      upnl: parseFloat(upnlTotal.toFixed(4)),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Capital contributions (Luis deposits) ────────────────────────────────────

router.get("/tanit/capital-contributions", async (req, res): Promise<void> => {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS capital_contributions (
        id SERIAL PRIMARY KEY,
        amount_usdt NUMERIC(20,8) NOT NULL,
        amount_mxn NUMERIC(20,4),
        exchange_rate NUMERIC(10,4),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `);
    const list = await db
      .select()
      .from(capitalContributions)
      .orderBy(capitalContributions.createdAt);
    const totalUsdt = list.reduce((s, r) => s + Number(r.amountUsdt ?? 0), 0);
    res.json({ ok: true, contributions: list, total_usdt: parseFloat(totalUsdt.toFixed(4)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post("/tanit/capital-contributions", async (req, res): Promise<void> => {
  try {
    const { amount_usdt, amount_mxn, exchange_rate, notes } = req.body ?? {};
    const usdt = parseFloat(amount_usdt);
    if (!Number.isFinite(usdt) || usdt <= 0) {
      res.status(400).json({ ok: false, error: "amount_usdt must be a positive number" });
      return;
    }
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS capital_contributions (
        id SERIAL PRIMARY KEY,
        amount_usdt NUMERIC(20,8) NOT NULL,
        amount_mxn NUMERIC(20,4),
        exchange_rate NUMERIC(10,4),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `);
    const [inserted] = await db
      .insert(capitalContributions)
      .values({
        amountUsdt: String(usdt),
        amountMxn: amount_mxn != null ? String(parseFloat(amount_mxn)) : null,
        exchangeRate: exchange_rate != null ? String(parseFloat(exchange_rate)) : null,
        notes: notes ? String(notes).slice(0, 500) : null,
      })
      .returning();
    res.json({ ok: true, contribution: inserted });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ─── Future: image generation & voice (501 Not Implemented for now) ───────────

router.post("/tanit/draw", (_req, res): void => {
  res.status(501).json({
    ok: false,
    error: "Image generation not yet implemented",
    plan: "Will use OpenAI DALL·E 3. Generated images persisted in tanit_creations table.",
  });
});

router.post("/tanit/speak", (_req, res): void => {
  res.status(501).json({
    ok: false,
    error: "Voice synthesis not yet implemented",
    plan: "Will use OpenAI TTS (cheap) or ElevenLabs (premium voice cloning).",
  });
});

// Suppress unused-import warning
void and;

export default router;
