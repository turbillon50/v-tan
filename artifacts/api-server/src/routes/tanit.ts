import { Router } from "express";
import {
  db,
  tanitChat,
  tanitMemory,
  tanitPersonalMemories,
  tanitEvolutions,
  tanitRuntimeConfig,
  tradeHistory,
  balanceSnapshots,
} from "@workspace/db";
import { desc, eq, sql, and } from "drizzle-orm";

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
    // Latest balance snapshot
    const [latestBalance] = await db
      .select()
      .from(balanceSnapshots)
      .orderBy(desc(balanceSnapshots.createdAt))
      .limit(1);

    // Trade stats (last 100 trades)
    const recentTrades = await db
      .select()
      .from(tradeHistory)
      .orderBy(desc(tradeHistory.openedAt))
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

    res.json({
      ok: true,
      state: {
        balance: latestBalance?.balance ?? null,
        equity: latestBalance?.equity ?? null,
        available: latestBalance?.available ?? null,
        balanceUpdatedAt: latestBalance?.createdAt ?? null,
        recentTrades: {
          total: recentTrades.length,
          wins,
          losses,
          winRate: parseFloat(winRate.toFixed(2)),
          totalPnl: parseFloat(totalPnl.toFixed(4)),
        },
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

// ─── Balance snapshots (equity curve in Analytics page) ───────────────────────

router.get("/tanit/balance-snapshots", async (req, res): Promise<void> => {
  try {
    const limit = safeLimit(req.query.limit, 200);
    const list = await db
      .select()
      .from(balanceSnapshots)
      .orderBy(balanceSnapshots.createdAt)
      .limit(limit);
    res.json({ ok: true, count: list.length, snapshots: list });
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
