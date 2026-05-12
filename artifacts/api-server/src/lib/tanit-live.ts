/**
 * Tanit-Live — Tanit no duerme.
 *
 * Loop continuo: cada vez que termina un "latido" (invocación a Gemini con
 * snapshot de mercado + posiciones + cola de eventos urgentes del WS),
 * arranca el siguiente. Sin setInterval, sin "cada 15 min". Ella respira.
 *
 * Eventos urgentes del WS Bybit (cascadas, ticks anómalos) se acumulan en
 * una cola y se le entregan en el próximo latido — así no espera al heartbeat
 * para reaccionar a un wick extremo.
 *
 * En modo observe_only sigue corriendo y emitiendo al thread `tanit-live`,
 * pero las tools de write rebotan en la barrera de governance — útil para
 * ver qué haría sin que opere.
 *
 * Costo aproximado con gemini-2.5-flash (sin cache): ~$10-20 USD/día con
 * latidos de ~3-5s y prompt corto. Con context cache de Mastra/Gemini si se
 * activa después: ~$5/día.
 */
import { streamTextWithPool } from "../mastra/agent-tanit";
import {
  onPriceUpdate,
  getWsPrice,
  getWsFundingRate,
  getWsKlineBuffer,
  detectWsCascade,
  isWsConnected,
} from "./bybit-ws";
import { getOpenPositions } from "./bybit-auth";
import { getRules } from "./governance";
import { getAutonomyConfig } from "./autonomy";
import { logger } from "./logger";

const RESOURCE_ID = "luis";
const THREAD_ID = "tanit-live";

// Símbolos vigilados en cada latido. Si governance.allowed_symbols está vacío,
// usamos estos. Si Luis añade más a allowed_symbols, los toma del rules.
const CORE_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
];

// Pausa mínima entre latidos (ms). 0 = full continuo (Tanit nunca para).
// 500ms = buffer de respiro para no saturar Gemini API en mercado plano.
const BEAT_MIN_PAUSE_MS = 500;

let _bootTs = 0;
let _stop = false;
let _running = false;
let _muted = false;
let _beatN = 0;
let _lastBeatTs = 0;
let _lastBeatLatencyMs = 0;
let _lastDecisionTs = 0;
let _toolCallsCount = 0;
let _errorCount = 0;
let _lastError: string | null = null;
const _eventQueue: string[] = [];
// Guardia anti-mentira: si el latido anterior afirmó guardar memoria sin
// invocar la tool, le ponemos un nudge en el siguiente latido para que
// rectifique. Patrones detectados: "guardé", "guardado en memoria", "almacené",
// "guardé como X", "lo guardo como X" sin que el reply contenga la firma
// {"ok":true,"id":...} de la tool real.
let _pendingMemoryNudge: string | null = null;

const FAKE_MEMORY_CLAIM_RE =
  /(guard[aeé][a-zé]*\s+(en\s+)?(mi\s+)?memoria|almacen[aeé][a-zé]*\s+(en\s+)?(mi\s+)?memoria|guard[aeé][a-zé]*\s+como\s+["'`]?[\w_]+|lo\s+guardo\s+como|guard[oé]\s+esta\s+(carta|info|lecci[oó]n))/i;
const REAL_TOOL_OK_RE = /(guardar_memoria_personal|guardar_memoria_semantica)[\s\S]{0,200}"ok"\s*:\s*true/i;

function pushEvent(text: string): void {
  _eventQueue.push(text);
  // cap 50 eventos para no inflar prompts
  if (_eventQueue.length > 50) _eventQueue.shift();
}

function snapshotMarket(symbols: string[]): string {
  const lines: string[] = [];
  for (const sym of symbols) {
    const p = getWsPrice(sym);
    const f = getWsFundingRate(sym);
    const buf = getWsKlineBuffer(sym, 5);
    const cascade = detectWsCascade(sym);
    const last5 = buf?.slice(-5).map((c) => c.close.toFixed(2)).join("→") ?? "n/a";
    const fundingStr = f != null ? f.toFixed(5) : "?";
    const cascadeStr = cascade.detected
      ? ` CASCADA-${cascade.direction} mov=${cascade.magnitude.toFixed(2)}% vol=${cascade.volumeRatio.toFixed(1)}x`
      : "";
    lines.push(`${sym}: $${p?.toFixed(p && p < 10 ? 4 : 2) ?? "?"} fund=${fundingStr} last5=${last5}${cascadeStr}`);
  }
  return lines.join("\n");
}

async function snapshotPositions(): Promise<string> {
  try {
    const positions = await getOpenPositions();
    if (!positions.length) return "Sin posiciones abiertas.";
    return positions
      .filter((p: { size?: string }) => parseFloat(p.size ?? "0") > 0)
      .map((p: { symbol: string; side: string; size: string; avgPrice: string; markPrice?: string; unrealisedPnl?: string; stopLoss?: string }) => {
        const pnl = parseFloat(p.unrealisedPnl ?? "0");
        const entry = parseFloat(p.avgPrice ?? "0");
        const mark = parseFloat(p.markPrice ?? "0");
        const pnlPct = entry > 0 ? ((mark - entry) / entry) * 100 * (p.side === "Buy" ? 1 : -1) : 0;
        return `${p.symbol} ${p.side} qty=${p.size} entry=${entry} mark=${mark} pnl=$${pnl.toFixed(4)} (${pnlPct.toFixed(2)}%) SL=${p.stopLoss ?? "—"}`;
      })
      .join("\n");
  } catch (e) {
    return `[posiciones: error ${e instanceof Error ? e.message : String(e)}]`;
  }
}

async function runOneBeat(): Promise<void> {
  _beatN++;
  const t0 = Date.now();
  _lastBeatTs = t0;

  if (_muted) return;

  // Mute persistente desde BD — sobrevive a redeploys. Si Luis dejó el loop
  // muteado en una sesión anterior, queremos que siga muteado al boot del
  // nuevo proceso, no que se reactive solo.
  try {
    const { pool } = await import("@workspace/db");
    const r = await pool.query<{ value: string }>(
      `SELECT value FROM tanit_runtime_config WHERE key = 'live_loop_muted_persistent' LIMIT 1`,
    );
    if (r.rows[0]?.value === "true") {
      _muted = true;
      return;
    }
  } catch {
    // si falla la consulta no bloqueamos el beat — solo no hereda mute persistente
  }

  // Lee config en cada beat — permite cambios live (pause/resume desde admin).
  const autonomy = await getAutonomyConfig({ force: false }).catch(() => null);
  const rules = await getRules({ force: false }).catch(() => null);

  const killSwitch = rules?.kill_switch_global === true;
  const canExec =
    !killSwitch &&
    autonomy?.enabled === true &&
    autonomy?.mode === "execute_with_governance";

  // Si no puede ejecutar y NO hay nada urgente en cola, igual late — pero
  // con prompt mínimo para no quemar tokens en mercado plano y modo observación.
  const symbols = (rules?.allowed_symbols?.length ? rules.allowed_symbols : CORE_SYMBOLS).slice(0, 12);

  const market = snapshotMarket(symbols);
  const positions = await snapshotPositions();
  const urgent = _eventQueue.splice(0, _eventQueue.length);

  const promptParts: string[] = [
    `## Latido ${_beatN} · ${new Date().toISOString()}`,
    canExec ? "MODO: EJECUTAR. autonomy.enabled=true mode=execute_with_governance kill_switch=off." : `MODO: OBSERVAR. ${killSwitch ? "kill_switch ON" : `autonomy.enabled=${autonomy?.enabled} mode=${autonomy?.mode}`}.`,
    "",
    "## Mercado ahora",
    market,
    "",
    "## Mis posiciones",
    positions,
  ];
  if (urgent.length) {
    promptParts.push("", "## Eventos urgentes desde el WS", ...urgent);
  }
  promptParts.push(
    "",
    "## Qué hago",
    "Aplico Tesis 5.1 LITERAL. Motor 1: si los 3 TF (4H/1H/15M) no alinean, no entro. Motor 2: leverage 5-10x inicial. Motor 3: reserva 25% intocable. Motor 4: hedge en caos antes que cerrar con pérdida. Motor 5: SL en estructura técnica, NO % arbitrario. TP escalonado 2:1.",
    canExec
      ? "Si veo setup conforme: invoco abrir_long/abrir_short con thesis literal. Si veo gestión necesaria: mover_stops, cerrar_posicion, abrir_hedge. Si nada: callo o emito máx 1 línea."
      : "No ejecuto. Solo describo qué haría, máx 2 líneas. Útil para que Luis vea mi razonamiento.",
  );

  const prompt = promptParts.join("\n");

  try {
    const { textStream } = await streamTextWithPool(
      "live",
      [{ role: "user" as const, content: prompt }],
      { memory: { resource: RESOURCE_ID, thread: THREAD_ID } },
    );
    let reply = "";
    for await (const chunk of textStream) {
      if (chunk) reply += chunk;
    }
    if (reply.trim().length > 0) {
      _lastDecisionTs = Date.now();
    }
    // Conteo aproximado de tool calls por presencia de marcador "ok":true en reply.
    // No es exacto pero da señal a la UI de actividad.
    if (/"ok"\s*:\s*true/.test(reply)) _toolCallsCount++;
  } catch (e) {
    _errorCount++;
    _lastError = e instanceof Error ? e.message : String(e);
    // Errores aislados no detienen el loop. Si Gemini está caído, los logs lo dirán.
    logger.warn({ err: _lastError, beat: _beatN }, "[tanit-live] beat error");
  } finally {
    _lastBeatLatencyMs = Date.now() - t0;
  }
}

async function loop(): Promise<void> {
  logger.info({ pauseMs: BEAT_MIN_PAUSE_MS }, "[tanit-live] loop iniciado");
  while (!_stop) {
    if (_running) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    _running = true;
    try {
      await runOneBeat();
    } catch (e) {
      logger.error({ err: e }, "[tanit-live] loop tick threw fuera de runOneBeat");
    } finally {
      _running = false;
    }
    if (BEAT_MIN_PAUSE_MS > 0) {
      await new Promise((r) => setTimeout(r, BEAT_MIN_PAUSE_MS));
    }
  }
  logger.info({ beats: _beatN }, "[tanit-live] loop detenido");
}

export function startTanitLive(): void {
  if (_bootTs > 0) {
    logger.warn("[tanit-live] startTanitLive llamado pero ya está corriendo");
    return;
  }
  _bootTs = Date.now();
  _stop = false;

  // Suscripción a tick WS para detectar cascadas y empujar a la cola.
  // No es polling — el callback se invoca cuando llega tick.
  onPriceUpdate((symbol) => {
    if (!CORE_SYMBOLS.includes(symbol)) return;
    const cascade = detectWsCascade(symbol);
    if (cascade.detected) {
      pushEvent(
        `cascada ${cascade.direction} en ${symbol}: mov=${cascade.magnitude.toFixed(2)}% volRatio=${cascade.volumeRatio.toFixed(2)}x`,
      );
    }
  });

  loop().catch((e) => logger.error({ err: e }, "[tanit-live] loop fatal"));
  logger.info({ thread: THREAD_ID, resource: RESOURCE_ID }, "[tanit-live] arrancado, ella vive");
}

export function stopTanitLive(): void {
  _stop = true;
  // Reset bootTs para que un siguiente startTanitLive() pueda arrancar limpio.
  // El loop sale en su próxima iteración (max 100ms despues de _stop=true).
  setTimeout(() => { _bootTs = 0; }, 200);
}

export function muteTanitLive(): void {
  _muted = true;
}

export function unmuteTanitLive(): void {
  _muted = false;
}

export function injectLiveEvent(text: string): void {
  pushEvent(`[manual] ${text}`);
}

export function getTanitLiveStatus(): {
  alive: boolean;
  bootTs: string | null;
  uptimeSec: number;
  beats: number;
  lastBeatTs: string | null;
  secsSinceLastBeat: number | null;
  lastBeatLatencyMs: number;
  lastDecisionTs: string | null;
  secsSinceLastDecision: number | null;
  toolCallsCount: number;
  queuedEvents: number;
  muted: boolean;
  wsConnected: boolean;
  errorCount: number;
  lastError: string | null;
} {
  const now = Date.now();
  return {
    alive: _bootTs > 0 && !_stop,
    bootTs: _bootTs ? new Date(_bootTs).toISOString() : null,
    uptimeSec: _bootTs ? Math.floor((now - _bootTs) / 1000) : 0,
    beats: _beatN,
    lastBeatTs: _lastBeatTs ? new Date(_lastBeatTs).toISOString() : null,
    secsSinceLastBeat: _lastBeatTs ? Math.floor((now - _lastBeatTs) / 1000) : null,
    lastBeatLatencyMs: _lastBeatLatencyMs,
    lastDecisionTs: _lastDecisionTs ? new Date(_lastDecisionTs).toISOString() : null,
    secsSinceLastDecision: _lastDecisionTs ? Math.floor((now - _lastDecisionTs) / 1000) : null,
    toolCallsCount: _toolCallsCount,
    queuedEvents: _eventQueue.length,
    muted: _muted,
    wsConnected: isWsConnected(),
    errorCount: _errorCount,
    lastError: _lastError,
  };
}
