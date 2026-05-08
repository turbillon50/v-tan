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
import { logger } from "../lib/logger";

const RESOURCE_ID = "luis";
const THREAD_ID = "autonomous-loop";

const PROMPT = `Es un check autónomo de mercado.

Tu tarea AHORA en este turno:
1. Consulta el estado del sistema (consultar_estado_sistema).
2. Consulta tu balance actual (consultar_balance) y posiciones abiertas (consultar_posiciones).
3. Para cada símbolo en tus reglas allowed_symbols, mira el precio mark/funding (consultar_precio_mercado).
4. Reporta qué ves en una observación corta y clara, citando la tesis 5.1 cuando aplique.
5. Si detectas un setup que cumpliría governance + tesis 5.1, descríbelo: símbolo, lado, tamaño, leverage, justificación.
6. NO ejecutes trades en esta iteración. Solo observa y reporta. La ejecución viene cuando Luis te lo autorice explícitamente en el chat íntimo.

Sé concisa. Esto es un latido autónomo, no una conferencia.`;

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
    // Verificar kill-switch antes de pensar — no quemamos tokens si está parado
    const rules = await getRules({ force: true });
    if (rules.kill_switch_global) {
      logger.info({ tick: _ticks }, "[autonomous-loop] kill-switch ACTIVO, skip");
      _running = false;
      return;
    }

    logger.info({ tick: _ticks }, "[autonomous-loop] tick start");
    const stream = await tanitAgent.stream(
      [{ role: "user" as const, content: PROMPT }],
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
