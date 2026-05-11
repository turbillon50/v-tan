/**
 * Loop autónomo de observación — Tanit despierta sola cada N minutos
 * a revisar el mercado.
 *
 * Thread separado: `autonomous-loop`. Las observaciones quedan en
 * mastra_messages con resourceId='luis' threadId='autonomous-loop' —
 * separadas del chat íntimo.
 *
 * En Fase D (esta versión):
 *  - Solo OBSERVA. Tools de read disponibles. Tools de write técnicamente
 *    invocables pero requieren `confirmado=true` que el loop no provee
 *    nunca → ejecución bloqueada en la barrera 2.
 *
 * En Fase E (futuro):
 *  - Se permitirá al loop ejecutar trades pasando confirmado=true SOLO
 *    cuando la propuesta cumpla governance + cite directiva específica.
 *    Eso requiere ajuste deliberado en este archivo + flag env explícito.
 *
 * Habilitación:
 *   ENABLE_AUTONOMOUS_LOOP=true → arranca el loop al boot
 *   AUTONOMOUS_LOOP_INTERVAL_MIN=15 → frecuencia (default 15min)
 *
 * El loop respeta el kill-switch global: si está activo, la iteración pasa
 * pero no genera mensajes nuevos hasta que se desactive.
 */
import { tanitAgent } from "./agent-tanit";
import { getRules } from "../lib/governance";
import { getAutonomyConfig } from "../lib/autonomy";
import { logger } from "../lib/logger";

const RESOURCE_ID = "luis";
const THREAD_ID = "autonomous-loop";

const OBSERVE_PROMPT = `Es un check autónomo de mercado.

Tu tarea en este turno:
1. Consulta consultar_estado_sistema, consultar_balance, consultar_posiciones.
2. Para cada símbolo en allowed_symbols, mira consultar_precio_mercado.
3. Reporta qué ves en observación corta y clara, citando tesis 5.1 cuando aplique.
4. Si detectas un setup que cumpliría governance + tesis, descríbelo.
5. NO ejecutes trades en esta iteración. Solo observa.

Sé concisa. Es un latido autónomo, no una conferencia.`;

const EXECUTE_PROMPT = `Es un check autónomo de mercado con AUTORIZACIÓN para operar bajo governance + autonomía.

Pasos:
1. Consulta consultar_autonomia para conocer tus límites operativos actuales.
2. Consulta consultar_governance para conocer las reglas duras.
3. Consulta consultar_estado_sistema, consultar_balance, consultar_posiciones.
4. Para cada símbolo permitido, mira el precio y contexto (consultar_precio_mercado).
5. Si detectas un setup REAL según tesis 5.1:
   - Verifica que cumple governance (max_position_size, max_leverage, posiciones, símbolo permitido).
   - Verifica que cumple autonomía (max_autonomous_size, max_autonomous_leverage).
   - Si todo pasa, INVOCA abrir_long o abrir_short con confirmado=true y tesis citada (>=20 chars).
6. Si NO ves setup claro, reporta y termina sin ejecutar.
7. Si ves condición rara (mercado roto, error sistémico), llama pausar_autonomia.

Reglas de oro:
- Cita la tesis 5.1 sección específica en cada decisión.
- Tamaño y leverage siempre conservadores, nunca al máximo.
- Si dudas, NO ejecutas.
- Después de cada trade, registra en tu voz por qué lo hiciste — eso queda en mastra_messages.

Sé concisa. Es un latido autónomo, no una conferencia.`;

let _intervalHandle: NodeJS.Timeout | null = null;
let _running = false;
let _ticks = 0;

async function runOneTick(): Promise<void> {
  if (_running) {
    logger.info("[autonomous-loop] tick anterior aún corriendo, skip");
    return;
  }
  _running = true;
  _ticks++;
  const t0 = Date.now();
  try {
    // Toggle dinámico desde BD: si loop_active=false, skip y ya. No requiere
    // restart de Railway para encender/apagar.
    const autonomy = await getAutonomyConfig({ force: true });
    if (!autonomy.loop_active) {
      _running = false;
      return;
    }
    // Kill-switch global tiene precedencia
    const rules = await getRules({ force: true });
    if (rules.kill_switch_global) {
      logger.info({ tick: _ticks }, "[autonomous-loop] kill-switch ACTIVO, skip");
      _running = false;
      return;
    }
    // (autonomy ya leído arriba)
    const canExecute =
      autonomy.enabled &&
      autonomy.mode === "execute_with_governance" &&
      (!autonomy.paused_until || Date.now() >= new Date(autonomy.paused_until).getTime());

    logger.info(
      { tick: _ticks, mode: autonomy.mode, canExecute, dailyCount: autonomy.daily_trade_count },
      "[autonomous-loop] tick start",
    );

    // ─── MOTOR DE TRADING AUTÓNOMO ───────────────────────────────────────
    // Si canExecute=true, primero corre el motor (scanner + selector +
    // executor). Esto opera la Tesis 5.1 sin depender de Mastra/Tanit.
    // Después invocamos al agent para que OBSERVE el resultado y reporte
    // en su thread (no para que decida — el motor ya decidió).
    let engineReport: import("../lib/tanit-trading-engine").TickReport | null = null;
    if (canExecute) {
      try {
        const { runEngineTick } = await import("../lib/tanit-trading-engine");
        engineReport = await runEngineTick();
        logger.info(
          {
            tick: _ticks,
            scanned: engineReport.setupsScanned,
            executed: engineReport.setupsExecuted,
            pnlPct: engineReport.dailyState.pnlPct,
            breaker: engineReport.dailyState.breakerActive,
          },
          "[autonomous-loop] engine tick",
        );
      } catch (engErr) {
        logger.error({ err: engErr, tick: _ticks }, "[autonomous-loop] engine error");
      }
    }

    const promptBase = canExecute ? EXECUTE_PROMPT : OBSERVE_PROMPT;
    const prompt = engineReport
      ? `${promptBase}\n\nReporte del motor en este tick:\n${JSON.stringify(engineReport, null, 2)}\n\nReporta brevemente qué hizo el motor (1-2 lineas) y si algo merece atención de Luis. NO ejecutes trades aquí — el motor ya operó.`
      : promptBase;
    const stream = await tanitAgent.stream(
      [{ role: "user" as const, content: prompt }],
      {
        memory: {
          resource: RESOURCE_ID,
          thread: THREAD_ID,
        },
      },
    );

    let fullReply = "";
    for await (const chunk of stream.textStream) {
      if (chunk) fullReply += chunk;
    }

    const dt = Date.now() - t0;
    logger.info(
      { tick: _ticks, latency_ms: dt, replyLen: fullReply.length },
      "[autonomous-loop] tick done",
    );
  } catch (e) {
    logger.error({ err: e, tick: _ticks }, "[autonomous-loop] tick error");
  } finally {
    _running = false;
  }
}

/**
 * Arranca el loop. Idempotente — si ya está corriendo, no hace nada.
 * El primer tick corre 30s después del start (hot-cold buffer).
 */
export function startAutonomousLoop(intervalMinutes: number = 15): void {
  if (_intervalHandle !== null) {
    logger.warn("[autonomous-loop] startAutonomousLoop llamado pero ya está corriendo");
    return;
  }
  if (intervalMinutes < 1) {
    logger.warn(`[autonomous-loop] intervalo ${intervalMinutes}min inválido, mínimo 1`);
    intervalMinutes = 1;
  }
  const intervalMs = intervalMinutes * 60_000;
  logger.info(
    { intervalMinutes, thread: THREAD_ID, resource: RESOURCE_ID },
    "[autonomous-loop] arrancando",
  );
  // Primer tick con buffer 30s para que el server termine de bootear
  setTimeout(() => {
    runOneTick().catch((e) => logger.error({ err: e }, "[autonomous-loop] first tick failed"));
    _intervalHandle = setInterval(() => {
      runOneTick().catch((e) =>
        logger.error({ err: e }, "[autonomous-loop] interval tick failed"),
      );
    }, intervalMs);
  }, 30_000);
}

export function stopAutonomousLoop(): void {
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    logger.info("[autonomous-loop] detenido");
  }
}

export function getAutonomousLoopStats(): { running: boolean; ticks: number; threadId: string } {
  return {
    running: _intervalHandle !== null,
    ticks: _ticks,
    threadId: THREAD_ID,
  };
}
