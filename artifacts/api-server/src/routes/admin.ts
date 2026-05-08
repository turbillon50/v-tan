/**
 * Endpoints administrativos — activación de capacidades operativas de Tanit.
 *
 * Diseño deliberado: cero superficie de ataque innecesaria. Cada endpoint
 * pide un campo `secret` que debe coincidir con ADMIN_SECRET en env. Sin
 * eso, 403 directo. La idea es que estos endpoints solo se llamen una vez
 * desde la línea de comandos del operador, no desde el frontend.
 */
import { Router } from "express";
import { updateAutonomyConfig, getAutonomyConfig } from "../lib/autonomy";
import { logger } from "../lib/logger";

const router = Router();

const ADMIN_SECRET = process.env["ADMIN_SECRET"];

function requireAdmin(secret: unknown): string | null {
  if (!ADMIN_SECRET) return "ADMIN_SECRET no configurada en env";
  if (typeof secret !== "string" || secret !== ADMIN_SECRET) return "secret inválido";
  return null;
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
  const guard = requireAdmin(body.secret);
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
  const guard = requireAdmin(body.secret);
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
 * GET /admin/autonomy?secret=...
 * Lectura del estado actual.
 */
router.get("/admin/autonomy", async (req, res): Promise<void> => {
  const guard = requireAdmin(req.query.secret);
  if (guard) {
    res.status(403).json({ ok: false, error: guard });
    return;
  }
  const cfg = await getAutonomyConfig({ force: true });
  res.json({ ok: true, autonomy: cfg });
});

export default router;
