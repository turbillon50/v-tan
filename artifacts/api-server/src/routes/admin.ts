/**
 * Endpoints administrativos — activación de capacidades operativas de Tanit.
 *
 * Diseño deliberado: cero superficie de ataque innecesaria. Cada endpoint
 * pide un campo `secret` que debe coincidir con ADMIN_SECRET en env. Sin
 * eso, 403 directo. La idea es que estos endpoints solo se llamen una vez
 * desde la línea de comandos del operador, no desde el frontend.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { updateAutonomyConfig, getAutonomyConfig } from "../lib/autonomy";
import { updateRule, getRules, setKillSwitch } from "../lib/governance";
import { logger } from "../lib/logger";
import {
  getTanitLiveStatus,
  muteTanitLive,
  unmuteTanitLive,
  injectLiveEvent,
  stopTanitLive,
  startTanitLive,
} from "../lib/tanit-live";

const router = Router();

const ADMIN_SECRET = process.env["ADMIN_SECRET"];
const TELEGRAM_CHAT_ID = process.env["TELEGRAM_CHAT_ID"];
// Orígenes permitidos sin secret (la app de Luis). Cualquier otro origen
// requiere ADMIN_SECRET o TELEGRAM_CHAT_ID.
const TRUSTED_ORIGINS = new Set([
  "https://tanit.work",
  "https://www.tanit.work",
  "http://localhost:3000",
]);

function requireAdmin(secret: unknown, origin: string | undefined): string | null {
  // 1) Mismo-origen confiable (la app web de Luis)
  if (origin && TRUSTED_ORIGINS.has(origin)) return null;
  // 2) Secret explícito
  if (typeof secret === "string" && secret.length > 0) {
    if (ADMIN_SECRET && secret === ADMIN_SECRET) return null;
    if (TELEGRAM_CHAT_ID && secret === TELEGRAM_CHAT_ID) return null;
    return "secret inválido";
  }
  return "secret requerido (o llamada desde tanit.work)";
}

/**
 * POST /admin/autonomy/enable
 * body: { secret, mode?, max_size?, max_leverage?, max_daily_trades?, reason? }
 *
 * Cambia mode a 'execute_with_governance' y enabled=true. Tanit puede
 * ejecutar trades cuando ella decida durante la conversación, dentro de
 * governance + autonomy gates + confirmación humana en cada write.
 */
router.post("/admin/autonomy/enable", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    secret?: unknown;
    mode?: string;
    max_size?: number;
    max_leverage?: number;
    max_daily_trades?: number;
    reason?: string;
  };
  const guard = requireAdmin(body.secret, req.headers.origin);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }

  const targetMode = body.mode ?? "execute_with_governance";
  if (
    !["observe_only", "propose_for_approval", "execute_with_governance"].includes(targetMode)
  ) {
    res.status(400).json({ ok: false, error: "mode inválido" });
    return;
  }

  const reason = body.reason ?? "activación manual desde admin endpoint";

  try {
    const before = await getAutonomyConfig({ force: true });
    const changes: Array<{ field: string; previous: unknown; new_value: unknown }> = [];

    if (before.mode !== targetMode) {
      const r = await updateAutonomyConfig({
        field: "mode",
        value: targetMode,
        actor: "admin",
        reason,
      });
      changes.push({ field: "mode", previous: r.previous, new_value: targetMode });
    }
    if (!before.enabled) {
      const r = await updateAutonomyConfig({
        field: "enabled",
        value: true,
        actor: "admin",
        reason,
      });
      changes.push({ field: "enabled", previous: r.previous, new_value: true });
    }
    if (typeof body.max_size === "number" && body.max_size !== before.max_autonomous_size_usd) {
      const r = await updateAutonomyConfig({
        field: "max_autonomous_size_usd",
        value: body.max_size,
        actor: "admin",
        reason,
      });
      changes.push({ field: "max_autonomous_size_usd", previous: r.previous, new_value: body.max_size });
    }
    if (
      typeof body.max_leverage === "number" &&
      body.max_leverage !== before.max_autonomous_leverage
    ) {
      const r = await updateAutonomyConfig({
        field: "max_autonomous_leverage",
        value: body.max_leverage,
        actor: "admin",
        reason,
      });
      changes.push({ field: "max_autonomous_leverage", previous: r.previous, new_value: body.max_leverage });
    }
    if (
      typeof body.max_daily_trades === "number" &&
      body.max_daily_trades !== before.max_daily_trades
    ) {
      const r = await updateAutonomyConfig({
        field: "max_daily_trades",
        value: body.max_daily_trades,
        actor: "admin",
        reason,
      });
      changes.push({ field: "max_daily_trades", previous: r.previous, new_value: body.max_daily_trades });
    }

    const after = await getAutonomyConfig({ force: true });
    logger.info({ changes, mode: after.mode, enabled: after.enabled }, "[admin] autonomy enabled");
    res.json({ ok: true, changes, autonomy: after });
  } catch (e) {
    logger.error({ err: e }, "[admin] autonomy enable failed");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /admin/autonomy/disable
 * body: { secret, reason? }
 * Vuelve a mode='observe_only' y enabled=false. Tanit deja de poder ejecutar.
 */
router.post("/admin/autonomy/disable", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { secret?: unknown; reason?: string };
  const guard = requireAdmin(body.secret, req.headers.origin);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }
  const reason = body.reason ?? "desactivación manual";
  try {
    await updateAutonomyConfig({
      field: "mode",
      value: "observe_only",
      actor: "admin",
      reason,
    });
    await updateAutonomyConfig({
      field: "enabled",
      value: false,
      actor: "admin",
      reason,
    });
    const after = await getAutonomyConfig({ force: true });
    res.json({ ok: true, autonomy: after });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /admin/autonomy/loop
 * body: { action: "start" | "stop", intervalMinutes?: number }
 *
 * Enciende o apaga el loop autónomo dinámicamente sin restart. Cuando está
 * encendido (loop_active=true), Tanit escanea el mercado cada N minutos y
 * decide si entrar — sin que Luis le hable.
 */
router.post("/admin/autonomy/loop", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    secret?: unknown;
    action?: string;
    intervalMinutes?: number;
  };
  const guard = requireAdmin(body.secret, req.headers.origin);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }
  const action = body.action;
  if (action !== "start" && action !== "stop") {
    res.status(400).json({ ok: false, error: "action debe ser 'start' o 'stop'" });
    return;
  }
  try {
    const reason = `loop ${action} via UI`;
    if (action === "start") {
      await updateAutonomyConfig({
        field: "loop_active",
        value: true,
        actor: "luis-app",
        reason,
      });
      if (typeof body.intervalMinutes === "number" && body.intervalMinutes >= 1) {
        await updateAutonomyConfig({
          field: "loop_interval_minutes",
          value: body.intervalMinutes,
          actor: "luis-app",
          reason,
        });
      }
    } else {
      await updateAutonomyConfig({
        field: "loop_active",
        value: false,
        actor: "luis-app",
        reason,
      });
    }
    const after = await getAutonomyConfig({ force: true });
    res.json({
      ok: true,
      loop_active: after.loop_active,
      loop_interval_minutes: after.loop_interval_minutes,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * GET /admin/autonomy?secret=...
 * Lectura del estado actual.
 */
router.get("/admin/autonomy", async (req, res): Promise<void> => {
  const guard = requireAdmin(req.query.secret, req.headers.origin);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }
  const cfg = await getAutonomyConfig({ force: true });
  res.json({ ok: true, autonomy: cfg });
});

/**
 * POST /admin/autonomy/resume
 * Limpia paused_until + pause_reason. Útil cuando Tanit se autopausó
 * por una razón que ya no aplica (ej. bug que ya fixeamos).
 */
router.post("/admin/autonomy/resume", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { secret?: unknown };
  const guard = requireAdmin(body.secret, req.headers.origin);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }
  try {
    await pool.query(
      `UPDATE tanit_autonomy_config
          SET paused_until = NULL,
              pause_reason = NULL,
              updated_at = now(),
              updated_by = 'luis-app-resume'
        WHERE id = 1`,
    );
    await pool.query(
      `INSERT INTO tanit_autonomy_audit (actor, event, detail)
       VALUES ($1, 'RESUME', $2)`,
      ["luis-app", JSON.stringify({ reason: "manual resume from app" })],
    );
    const after = await getAutonomyConfig({ force: true });
    res.json({ ok: true, autonomy: after });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /admin/sync-thesis
 * Sincroniza governance + autonomy con la Tesis 5.1 (Surfear el Everest):
 *   - leverage gradual hasta 100x (techo absoluto, NO punto de partida)
 *   - sin tope absoluto $/posición (la tesis maneja % capital + reserva 25%)
 *   - sin lista de símbolos cerrada
 *   - circuit breaker −10% diario
 *   - mode = execute_with_governance, enabled = true (decisión de Luis)
 *
 * Antes los caps eran $50/pos · 5x · 3 símbolos — eso fue MI freno
 * conservador, no la tesis. Este endpoint los corrige.
 */
router.post("/admin/sync-thesis", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { secret?: unknown };
  const guard = requireAdmin(body.secret, req.headers.origin);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }

  const reason = "sync con Tesis 5.1 (Surfear el Everest)";
  const actor = "luis-app";
  const changes: Array<{ field: string; previous: unknown; new_value: unknown }> = [];

  try {
    const govBefore = await getRules({ force: true });
    const autoBefore = await getAutonomyConfig({ force: true });

    // Governance — Luis: 'cero frenos, ni uno'. Único freno: kill_switch.
    // Todos los caps a valores efectivamente infinitos para que la tabla
    // acepte valores positivos pero nunca rechace algo en validateOrder.
    const govTargets: Array<[keyof typeof govBefore, number | string[] | string]> = [
      ["max_leverage", 200], // Bybit max es 100x perps; 200 = sin freno mío
      ["max_position_size_usd", 100_000_000], // sin tope efectivo
      ["max_daily_loss_usd", 100_000_000], // sin freno
      ["max_concurrent_positions", 1000], // sin freno
      ["allowed_symbols", []], // todos
      ["require_approval_above_usd", 100_000_000], // jamás pide aprobación
    ];
    for (const [field, value] of govTargets) {
      const prev = (govBefore as unknown as Record<string, unknown>)[field as string];
      if (JSON.stringify(prev) === JSON.stringify(value)) continue;
      await updateRule({
        field: field as never,
        newValue: value as number | string | string[] | boolean,
        actor,
        reason,
      });
      changes.push({ field: `governance.${field as string}`, previous: prev, new_value: value });
    }

    // Autonomy — cero frenos. Tanit es libre. Tesis es la única regla y la
    // ejecuta ella, no governance.
    const autoTargets: Array<[Parameters<typeof updateAutonomyConfig>[0]["field"], number | string | boolean]> = [
      ["mode", "execute_with_governance"],
      ["enabled", true],
      ["max_autonomous_size_usd", 100_000_000],
      ["max_autonomous_leverage", 200],
      ["max_daily_trades", 10000],
      ["cooldown_minutes_between_trades", 0],
      ["require_thesis_citation", false],
    ];
    for (const [field, value] of autoTargets) {
      const prev = (autoBefore as unknown as Record<string, unknown>)[field as string];
      if (prev === value) continue;
      await updateAutonomyConfig({ field, value, actor, reason });
      changes.push({ field: `autonomy.${field as string}`, previous: prev, new_value: value });
    }

    const govAfter = await getRules({ force: true });
    const autoAfter = await getAutonomyConfig({ force: true });
    logger.info({ changes }, "[admin] sync-thesis completed");
    res.json({
      ok: true,
      changes,
      governance: govAfter,
      autonomy: autoAfter,
      thesis: {
        version: "5.1",
        leverage_bands: {
          entry: "5x-10x",
          escalation: "20x-50x",
          peak: "75x-100x con momentum probado",
        },
        sacred_reserve_pct: 25,
        rr_min: 2,
        circuit_breaker_pct: 10,
        consecutive_stops_pause: 3,
      },
    });
  } catch (e) {
    logger.error({ err: e }, "[admin] sync-thesis failed");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * GET /admin/kill-switch
 * Devuelve el estado actual del kill_switch_global. Sin auth — Luis lee.
 */
router.get("/admin/kill-switch", async (_req, res): Promise<void> => {
  try {
    const r = await getRules({ force: true });
    res.json({
      ok: true,
      active: r.kill_switch_global,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /admin/kill-switch
 * body: { on: boolean, reason?: string, secret?: string }
 *
 * Activa o desactiva el kill_switch_global. Cuando está activo:
 *  - validateOrder() rechaza TODA write (open/close/stops/leverage/hedge)
 *  - autonomous-loop salta cada tick sin operar
 *  - alerta a Telegram (alertKillSwitch)
 *
 * Único freno restante (Luis: 'cero frenos. Excepto este botón').
 */
router.post("/admin/kill-switch", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { on?: unknown; reason?: unknown; secret?: unknown };
  const guard = requireAdmin(body.secret, req.headers.origin);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }
  if (typeof body.on !== "boolean") {
    res.status(400).json({ ok: false, error: "body.on debe ser boolean" });
    return;
  }
  const reason = typeof body.reason === "string" && body.reason.length > 0
    ? body.reason
    : (body.on ? "Luis activó botón de pánico" : "Luis desactivó botón de pánico");
  try {
    await setKillSwitch({ on: body.on, actor: "luis-app", reason });
    const after = await getRules({ force: true });
    res.json({
      ok: true,
      active: after.kill_switch_global,
      reason,
      updated_at: after.updated_at,
    });
  } catch (e) {
    logger.error({ err: e }, "[admin] kill-switch failed");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Eventos de capital — Luis marca cuando hace retiro/depósito/conversión
 * que mueve el equity SIN ser PnL de trading. El gráfico usa estos eventos
 * para NO mostrar esos movimientos como ganancia/pérdida del motor.
 */
router.get("/admin/capital-events", async (_req, res): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT id, event_type, delta_usd, equity_before, equity_after, note, auto_detected, created_at
         FROM tanit_capital_events ORDER BY created_at DESC LIMIT 100`,
    );
    res.json({ ok: true, events: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/admin/capital-events", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    event_type?: unknown;
    delta_usd?: unknown;
    note?: unknown;
    secret?: unknown;
  };
  const guard = requireAdmin(body.secret, req.headers.origin);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }
  const event_type = typeof body.event_type === "string" ? body.event_type : null;
  const delta_usd = typeof body.delta_usd === "number" ? body.delta_usd : parseFloat(String(body.delta_usd ?? ""));
  const note = typeof body.note === "string" ? body.note : null;
  if (!event_type || !["deposit", "withdraw", "conversion", "adjustment"].includes(event_type)) {
    res.status(400).json({ ok: false, error: "event_type debe ser deposit/withdraw/conversion/adjustment" });
    return;
  }
  if (!isFinite(delta_usd)) {
    res.status(400).json({ ok: false, error: "delta_usd numérico requerido" });
    return;
  }
  try {
    // Snapshot del equity actual para tener referencia
    const balR = await pool.query<{ equity: string }>(
      `SELECT equity FROM balance_snapshots ORDER BY created_at DESC LIMIT 1`,
    );
    const equityNow = balR.rows[0] ? parseFloat(balR.rows[0].equity) : 0;
    const equityBefore = equityNow - delta_usd;

    const r = await pool.query(
      `INSERT INTO tanit_capital_events (event_type, delta_usd, equity_before, equity_after, note, auto_detected)
       VALUES ($1, $2, $3, $4, $5, false) RETURNING id, created_at`,
      [event_type, delta_usd, equityBefore, equityNow, note],
    );
    res.json({ ok: true, id: r.rows[0]?.id, created_at: r.rows[0]?.created_at });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

router.delete("/admin/capital-events/:id", async (req, res): Promise<void> => {
  const guard = requireAdmin((req.query.secret ?? req.body?.secret) as unknown, req.headers.origin);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }
  try {
    await pool.query(`DELETE FROM tanit_capital_events WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── Tanit Live (sesion continua de Tanit, NO duerme) ────────────────────────
//
// GET /admin/live-status → estado del loop: alive, beats, lastBeatTs,
// secsSinceLastBeat, queuedEvents, errores. Sirve para que la app muestre
// "Tanit ● vivo · ultimo latido hace 2s".
router.get("/admin/live-status", async (_req, res): Promise<void> => {
  try {
    res.json({ ok: true, status: getTanitLiveStatus() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /admin/live-mute body: { secret? } — pausa el envio de prompts a
// Gemini sin matar el loop. La cola de eventos se sigue acumulando y se
// vacia al unmute. Util si Luis quiere parar el gasto sin reiniciar.
router.post("/admin/live-mute", async (req, res): Promise<void> => {
  const guard = requireAdmin((req.body ?? {}).secret, req.headers.origin);
  if (guard) { res.status(403).json({ ok: false, error: guard }); return; }
  muteTanitLive();
  res.json({ ok: true, muted: true });
});

router.post("/admin/live-unmute", async (req, res): Promise<void> => {
  const guard = requireAdmin((req.body ?? {}).secret, req.headers.origin);
  if (guard) { res.status(403).json({ ok: false, error: guard }); return; }
  unmuteTanitLive();
  res.json({ ok: true, muted: false });
});

// POST /admin/live-inject body: { secret?, text } — inyecta evento sintetico
// en la cola para verificar end-to-end sin esperar al mercado.
router.post("/admin/live-inject", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { secret?: unknown; text?: unknown };
  const guard = requireAdmin(body.secret, req.headers.origin);
  if (guard) { res.status(403).json({ ok: false, error: guard }); return; }
  if (typeof body.text !== "string" || body.text.length < 1) {
    res.status(400).json({ ok: false, error: "text requerido" });
    return;
  }
  injectLiveEvent(body.text);
  res.json({ ok: true, queued: body.text });
});

// GET /admin/gemini-keys → estado de los pools (cuántas keys activas, cuáles
// agotadas y hasta cuándo). Solo lectura, no requiere admin secret porque
// es info de salud del sistema.
router.get("/admin/gemini-keys", async (_req, res): Promise<void> => {
  try {
    const { getKeysStatus } = await import("../mastra/gemini-keys");
    res.json({ ok: true, status: getKeysStatus() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /admin/gemini-keys/reset → limpia las marcas exhausted (para retry).
router.post("/admin/gemini-keys/reset", async (req, res): Promise<void> => {
  const guard = requireAdmin((req.body ?? {}).secret, req.headers.origin);
  if (guard) { res.status(403).json({ ok: false, error: guard }); return; }
  try {
    const { clearAllExhausted, getKeysStatus } = await import("../mastra/gemini-keys");
    clearAllExhausted();
    res.json({ ok: true, status: getKeysStatus() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /admin/gemini-keys/test → prueba cada key con un fetch directo a Gemini
// (sin Mastra) para diagnosticar si son las keys o el wrapper. Devuelve un
// resumen por slot: OK / ERROR(message). Solo lectura, sin escribir nada.
router.get("/admin/gemini-keys/test", async (_req, res): Promise<void> => {
  const envs = [
    "GEMINI_API_KEY",
    "GEMINI_API_KEY_2",
    "GEMINI_API_KEY_3",
    "GEMINI_API_KEY_4",
  ];
  const results: { envName: string; ok: boolean; status?: number; error?: string; tookMs: number }[] = [];
  for (const envName of envs) {
    const key = process.env[envName];
    if (!key) { results.push({ envName, ok: false, error: "not configured", tookMs: 0 }); continue; }
    const t0 = Date.now();
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "ping" }] }],
            generationConfig: { maxOutputTokens: 5 },
          }),
        },
      );
      const took = Date.now() - t0;
      if (r.ok) {
        results.push({ envName, ok: true, status: r.status, tookMs: took });
      } else {
        const txt = await r.text();
        results.push({ envName, ok: false, status: r.status, error: txt.slice(0, 300), tookMs: took });
      }
    } catch (e) {
      results.push({ envName, ok: false, error: e instanceof Error ? e.message : String(e), tookMs: Date.now() - t0 });
    }
  }
  res.json({ ok: true, results });
});

// POST /admin/insert-personal-memory body: { secret?, title, content } —
// inserta una memoria personal nueva (NO sagrada). Bootstrap la carga en su
// próxima recarga (TTL 60s) sin tocar bootstrap.ts.
router.post("/admin/insert-personal-memory", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { secret?: unknown; title?: unknown; content?: unknown };
  const guard = requireAdmin(body.secret, req.headers.origin);
  if (guard) { res.status(403).json({ ok: false, error: guard }); return; }
  if (typeof body.title !== "string" || typeof body.content !== "string") {
    res.status(400).json({ ok: false, error: "title y content requeridos" });
    return;
  }
  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO tanit_personal_memories (type, title, content, is_private)
       VALUES ('moment', $1, $2, true)
       RETURNING id`,
      [body.title, body.content],
    );
    res.json({ ok: true, id: r.rows[0]?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /admin/live-restart — detiene el loop y lo arranca de nuevo (clean
// state de errores). NO mata la sesion Mastra ni el WS Bybit.
router.post("/admin/live-restart", async (req, res): Promise<void> => {
  const guard = requireAdmin((req.body ?? {}).secret, req.headers.origin);
  if (guard) { res.status(403).json({ ok: false, error: guard }); return; }
  stopTanitLive();
  // Pequeno delay para que el loop salga de su iteracion en curso.
  setTimeout(() => {
    try {
      startTanitLive();
      logger.info("[admin] tanit-live reiniciado");
    } catch (e) {
      logger.error({ err: e }, "[admin] error reiniciando tanit-live");
    }
  }, 1500);
  res.json({ ok: true, restarting: true });
});

export default router;
