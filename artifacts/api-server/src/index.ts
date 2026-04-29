import app from "./app";
import { logger } from "./lib/logger";
import { initTelegramCommands } from "./lib/telegram-commands";
import { sendTelegram } from "./lib/telegram";
import { sendBotStartupAlert, engineReadyPromise } from "./lib/trading-engine";

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

  // Iniciar polling de comandos Telegram (pausa, reanuda, estado, informe)
  initTelegramCommands();

  // Aviso de arranque — espera a que el engine esté verdaderamente listo antes de anunciar
  engineReadyPromise.then(() => sendBotStartupAlert()).catch(() => {});
});
