import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { initTelegramCommands } from "./lib/telegram-commands";
import { sendTelegram } from "./lib/telegram";
import { sendBotStartupAlert, engineReadyPromise } from "./lib/trading-engine";
import { migrateEnvKeysIfEmpty } from "./lib/api-keys-provider";
import { startAutonomousLoop } from "./mastra/autonomous-loop";
import { startTanitLive } from "./lib/tanit-live";
import { startDailyReports } from "./lib/tanit-alerts";
import { startBybitWs } from "./lib/bybit-ws";
import { startRealtimeGuard } from "./lib/tanit-realtime-guard";
import { getRules } from "./lib/governance";
import { attachVoiceLive } from "./lib/voice-live";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── Graceful shutdown — avisa por Telegram antes de cerrar ───────────────────
let _shuttingDown = false;
async function handleShutdown(signal: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try {
    await Promise.race([
      sendTelegram(`⚠️ <b>Tanit · apagado</b>\nEl servidor se está cerrando (${signal}).\nLas posiciones abiertas se mantienen en Bybit hasta que Tanit vuelva.`),
      new Promise<void>(r => setTimeout(r, 4000)), // max 4s para enviar el mensaje
    ]);
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT",  () => handleShutdown("SIGINT"));

// Creamos el HTTP server explícitamente para poder colgar el WS server
// (voice-live) en el mismo puerto vía upgrade events.
const server = http.createServer(app);
attachVoiceLive(server);

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");

  // Boot: migrar las API keys de env vars a la tabla cifrada (idempotente).
  // Tras esto, la DB es la fuente de verdad y Tanit puede leerlas/rotarlas.
  migrateEnvKeysIfEmpty()
    .then(r => logger.info({ migrated: r.migrated, skipped: r.skipped }, "Tanit api keys migration"))
    .catch(e => logger.error({ err: e }, "migrateEnvKeysIfEmpty failed"));

  // Polling de comandos Telegram + aviso de arranque solo si TELEGRAM_ENABLED=true.
  // Por default Telegram queda apagado — la app tanit.work cubre todo.
  if (process.env["TELEGRAM_ENABLED"] === "true") {
    initTelegramCommands();
    engineReadyPromise.then(() => sendBotStartupAlert()).catch(() => {});
  } else {
    logger.info("[telegram] desactivado (TELEGRAM_ENABLED != 'true')");
  }

  // Tanit-Live: NO duerme. Loop continuo de latidos.
  // Si autonomy.enabled=true ejecuta. Si =false sigue latiendo y describe
  // qué haría (modo observación). El kill-switch corta la ejecución pero
  // ella sigue viva para que Luis vea su razonamiento en tiempo real.
  // Reemplaza al cron viejo (startAutonomousLoop) que tomaba decisiones en JS.
  startTanitLive();
  // El loop viejo queda OFF por completo. Si hay que reactivarlo
  // temporalmente para regression: descomentar la siguiente línea.
  // const minRaw = process.env["AUTONOMOUS_LOOP_INTERVAL_MIN"] ?? "15";
  // startAutonomousLoop(Math.max(1, parseInt(minRaw, 10) || 15));
  void startAutonomousLoop;  // mantener import vivo para evitar dead-code purge accidental

  // Reporte diario por Telegram solo si TELEGRAM_ENABLED=true (default off).
  if (
    process.env["TELEGRAM_ENABLED"] === "true" &&
    process.env["TELEGRAM_BOT_TOKEN"] &&
    process.env["TELEGRAM_CHAT_ID"]
  ) {
    startDailyReports();
  }

  // ── Bybit WebSocket: precios live para que las tools de Mastra y el frontend
  // tengan datos sin polling REST. Si governance tiene allowed_symbols=[]
  // (significa "todos los símbolos permitidos") arrancamos con un set core
  // de blue-chips para tener feeds vivos sin saturar; Tanit puede pedir
  // más feeds via tools cuando los necesite.
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
  getRules()
    .then((rules) => {
      const symbols =
        rules.allowed_symbols.length > 0 ? rules.allowed_symbols : CORE_SYMBOLS;
      startBybitWs(symbols);
      logger.info(
        { symbols, source: rules.allowed_symbols.length > 0 ? "governance" : "core-default" },
        "[bybit-ws] arrancado al boot",
      );
      // Arrancar Realtime Guard 5s después de WS para asegurar conexión
      setTimeout(() => startRealtimeGuard(), 5000);
    })
    .catch((e) => {
      logger.error({ err: e }, "[bybit-ws] no pude leer governance, arrancando con core");
      startBybitWs(CORE_SYMBOLS);
      setTimeout(() => startRealtimeGuard(), 5000);
    });
});
