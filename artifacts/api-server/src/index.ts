import app from "./app";
import { logger } from "./lib/logger";
import { initTelegramCommands } from "./lib/telegram-commands";
import { sendTelegram } from "./lib/telegram";
import { sendBotStartupAlert, engineReadyPromise } from "./lib/trading-engine";
import { migrateEnvKeysIfEmpty } from "./lib/api-keys-provider";
import { startAutonomousLoop } from "./mastra/autonomous-loop";
import { startDailyReports } from "./lib/tanit-alerts";
import { startBybitWs } from "./lib/bybit-ws";
import { getRules } from "./lib/governance";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Boot: migrar las API keys de env vars a la tabla cifrada (idempotente).
  // Tras esto, la DB es la fuente de verdad y Tanit puede leerlas/rotarlas.
  migrateEnvKeysIfEmpty()
    .then(r => logger.info({ migrated: r.migrated, skipped: r.skipped }, "Tanit api keys migration"))
    .catch(e => logger.error({ err: e }, "migrateEnvKeysIfEmpty failed"));

  // Iniciar polling de comandos Telegram (pausa, reanuda, estado, informe)
  initTelegramCommands();

  // Aviso de arranque — espera a que el engine esté verdaderamente listo antes de anunciar
  engineReadyPromise.then(() => sendBotStartupAlert()).catch(() => {});

  // Loop autónomo de observación (Fase D). Solo arranca si el flag está
  // explícitamente en true. Las write tools requieren confirmado=true que
  // el loop no provee — es seguridad nativa.
  if (process.env["ENABLE_AUTONOMOUS_LOOP"] === "true") {
    const minRaw = process.env["AUTONOMOUS_LOOP_INTERVAL_MIN"] ?? "15";
    const min = Math.max(1, parseInt(minRaw, 10) || 15);
    startAutonomousLoop(min);
  } else {
    logger.info("[autonomous-loop] desactivado (ENABLE_AUTONOMOUS_LOOP != 'true')");
  }

  // Reporte diario por Telegram (Fase H). Idempotente. Primer reporte 6h
  // después del start; luego cada 24h. Solo si hay TELEGRAM_CHAT_ID.
  if (process.env["TELEGRAM_BOT_TOKEN"] && process.env["TELEGRAM_CHAT_ID"]) {
    startDailyReports();
  }

  // ── Bybit WebSocket: precios live para que las tools de Mastra y el frontend
  // tengan datos sin polling REST. Antes esto solo arrancaba dentro de
  // startEngine() del trading-engine viejo, que ya no llamamos. Aquí lo
  // disparamos directo con los allowed_symbols de governance.
  // Sin esto, Tanit reporta wsConnected=false y opera a ciegas.
  getRules()
    .then((rules) => {
      if (rules.allowed_symbols.length > 0) {
        startBybitWs(rules.allowed_symbols);
        logger.info(
          { symbols: rules.allowed_symbols },
          "[bybit-ws] arrancado al boot con governance.allowed_symbols",
        );
      } else {
        logger.warn("[bybit-ws] sin símbolos en governance, WS no arrancado");
      }
    })
    .catch((e) => logger.error({ err: e }, "[bybit-ws] no pude leer governance"));
});
