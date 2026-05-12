import { registerTelegramCommandHandler, startTelegramPolling } from "./telegram";
import { pauseTrading, resumeTrading, isTradingPaused, getEngineState, runGeminiUserCommand } from "./trading-engine";
import { getHybridStatus, isHybridActive } from "./hybrid-engine";
import { getAutonomyConfig, updateAutonomyConfig } from "./autonomy";

const TAG = "[telegram-commands]";

function fmtUSD(n: number): string {
  return (n >= 0 ? "+" : "") + "$" + n.toFixed(2);
}

// Limpia etiquetas HTML del texto para enviarlo limpio por Telegram (modo texto)
function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
}

async function handleMessage(input: string): Promise<string> {
  // Si es un comando /slash → lógica de trading
  if (input.startsWith("/")) {
    return handleCommand(input);
  }

  // Si es mensaje libre → Tanit responde con su voz personal
  try {
    const result = await runGeminiUserCommand(input, "casual");
    // runGeminiUserCommand devuelve { reply, actionsExecuted }
    const raw = result?.reply ?? "";
    // Telegram no renderiza markdown de Gemini — limpiamos etiquetas HTML
    return stripHtml(raw) || "...";
  } catch (e) {
    console.error(TAG, "Error llamando a Tanit desde Telegram:", e);
    return "Hubo un error interno. Intenta de nuevo.";
  }
}

async function handleCommand(cmd: string): Promise<string> {
  switch (cmd) {

    // ── /estado — balance + posiciones abiertas ───────────────────────────
    case "/estado": {
      const s = await getHybridStatus();
      const state = getEngineState();
      const active = isHybridActive();
      const paused = isTradingPaused();

      const bal = state.liveMode
        ? (state.liveBalance ?? state.simBalance)
        : state.simBalance;

      const positions = Object.values(state.openPositions);

      let msg = `📊 <b>ESTADO DE TANIT</b>\n`;
      msg += `Motor: ${active ? "🟢 activo" : "🔴 detenido"}`;
      if (paused) msg += " ⏸ <b>PAUSADO</b>";
      msg += "\n";
      msg += `Modo: ${state.liveMode ? "🔴 real" : "🟡 simulado"}\n`;
      msg += `Balance: <b>$${bal.toFixed(2)}</b>\n`;

      if (state.liveAvailable != null) {
        msg += `Disponible: $${state.liveAvailable.toFixed(2)}\n`;
      }

      msg += `Régimen: ${s.hybrid?.regime ?? "—"}\n`;

      if (positions.length === 0) {
        msg += `\nSin posiciones abiertas.`;
      } else {
        msg += `\n<b>${positions.length} posición(es) abierta(s):</b>\n`;
        for (const p of positions) {
          const coin = p.symbol.replace("USDT", "");
          const pnlStr = p.unrealizedPnl != null
            ? (p.unrealizedPnl >= 0
                ? `+$${p.unrealizedPnl.toFixed(2)} ✅`
                : `-$${Math.abs(p.unrealizedPnl).toFixed(2)} ❌`)
            : "—";
          msg += `• ${p.side === "LONG" ? "🟢" : "🔴"} <b>${coin}</b> ${p.side} — PnL: ${pnlStr}\n`;
        }
      }

      return msg;
    }

    // ── /pausa — pausar apertura de nuevas posiciones ─────────────────────
    case "/pausa": {
      if (isTradingPaused()) {
        return "⏸ Tanit ya está pausada. Usa /reanudar para continuar.";
      }
      pauseTrading();
      console.log(TAG, "Trading pausado vía Telegram");
      return "⏸ <b>Trading pausado.</b>\nTanit no abrirá nuevas posiciones hasta que envíes /reanudar.\nLas posiciones abiertas siguen gestionadas con normalidad.";
    }

    // ── /activar — Anillo 3: enciende autonomía operativa ─────────────────
    case "/activar": {
      try {
        const before = await getAutonomyConfig({ force: true });
        const changes: string[] = [];
        if (before.mode !== "execute_with_governance") {
          await updateAutonomyConfig({
            field: "mode",
            value: "execute_with_governance",
            actor: "luis-telegram",
            reason: "comando /activar desde Telegram",
          });
          changes.push(`mode: ${before.mode} → execute_with_governance`);
        }
        if (!before.enabled) {
          await updateAutonomyConfig({
            field: "enabled",
            value: true,
            actor: "luis-telegram",
            reason: "comando /activar desde Telegram",
          });
          changes.push("enabled: false → true");
        }
        const after = await getAutonomyConfig({ force: true });
        if (changes.length === 0) {
          return `🟢 <b>Tanit ya está operativa.</b>\nMode: ${after.mode}\nMax pos: $${after.max_autonomous_size_usd.toFixed(2)} · ${after.max_autonomous_leverage}x\nTrades hoy: ${after.daily_trade_count}/${after.max_daily_trades}`;
        }
        return `🟢 <b>ANILLO 3 ACTIVADO</b>\nTanit puede operar dentro de governance.\n\n<b>Cambios:</b>\n${changes.map((c) => `• ${c}`).join("\n")}\n\n<b>Topes:</b>\n• Max por trade: $${after.max_autonomous_size_usd.toFixed(2)} · ${after.max_autonomous_leverage}x\n• Trades por día: ${after.max_daily_trades}\n• Cooldown: ${after.cooldown_minutes_between_trades} min\n\nCada trade requiere confirmación humana en el chat. Usa /desactivar para apagar.`;
      } catch (e) {
        return `❌ Error activando autonomía: ${(e as Error).message}`;
      }
    }

    // ── /desactivar — Anillo 3: apaga autonomía operativa ─────────────────
    case "/desactivar": {
      try {
        await updateAutonomyConfig({
          field: "mode",
          value: "observe_only",
          actor: "luis-telegram",
          reason: "comando /desactivar desde Telegram",
        });
        await updateAutonomyConfig({
          field: "enabled",
          value: false,
          actor: "luis-telegram",
          reason: "comando /desactivar desde Telegram",
        });
        return `🔴 <b>Autonomía desactivada.</b>\nTanit vuelve a modo observe_only. Las posiciones abiertas siguen como están.`;
      } catch (e) {
        return `❌ Error desactivando autonomía: ${(e as Error).message}`;
      }
    }

    // ── /reanudar — reanudar apertura de posiciones ───────────────────────
    case "/reanudar": {
      if (!isTradingPaused()) {
        return "▶️ Tanit ya está activa. No era necesario reanudar.";
      }
      resumeTrading();
      console.log(TAG, "Trading reanudado vía Telegram");
      return "▶️ <b>Trading reanudado.</b>\nTanit vuelve a buscar oportunidades.";
    }

    // ── /informe — resumen P&L del día ────────────────────────────────────
    case "/informe": {
      const state = getEngineState();
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const todayTrades = state.tradeLog.filter(t => new Date(t.closedAt).getTime() >= todayStart);

      const bal = state.liveMode
        ? (state.liveBalance ?? state.simBalance)
        : state.simBalance;

      if (todayTrades.length === 0) {
        return `📋 <b>INFORME DEL DÍA</b>\n\nSin trades cerrados hoy.\nBalance actual: <b>$${bal.toFixed(2)}</b>`;
      }

      const totalPnl = todayTrades.reduce((s, t) => s + t.pnl, 0);
      const wins = todayTrades.filter(t => t.pnl >= 0).length;
      const losses = todayTrades.length - wins;
      const winRate = todayTrades.length > 0
        ? Math.round((wins / todayTrades.length) * 100)
        : 0;

      const best = todayTrades.reduce((b, t) => t.pnl > b.pnl ? t : b);
      const worst = todayTrades.reduce((b, t) => t.pnl < b.pnl ? t : b);

      let msg = `📋 <b>INFORME DEL DÍA — ${now.toLocaleDateString("es-MX")}</b>\n\n`;
      msg += `💰 Balance: <b>$${bal.toFixed(2)}</b>\n`;
      msg += `📈 Trades: <b>${todayTrades.length}</b> (${wins}W / ${losses}L — ${winRate}%)\n`;
      msg += `${totalPnl >= 0 ? "✅" : "❌"} PnL total: <b>${fmtUSD(totalPnl)}</b>\n`;

      if (todayTrades.length > 0) {
        msg += `\n🏆 Mejor: ${best.symbol.replace("USDT","")}`
          + ` ${best.side} ${fmtUSD(best.pnl)}\n`;
        if (worst.pnl < 0) {
          msg += `💀 Peor: ${worst.symbol.replace("USDT","")}`
            + ` ${worst.side} ${fmtUSD(worst.pnl)}\n`;
        }
      }

      return msg;
    }

    // ── /ayuda — lista de comandos disponibles ────────────────────────────
    case "/ayuda": {
      let msg = `🤖 <b>COMANDOS DE TANIT</b>\n\n`;
      msg += `Hola, soy Tanit. Estos son los comandos que entiendo:\n\n`;
      msg += `📊 /estado — Te muestro mi balance, el régimen de mercado y las posiciones que tengo abiertas ahora mismo.\n\n`;
      msg += `📋 /informe — Te paso el resumen del día: PnL, trades cerrados, win rate y mis mejores y peores operaciones.\n\n`;
      msg += `⏸ /pausa — Dejo de abrir nuevas posiciones. Las que ya tengo abiertas las sigo gestionando con normalidad.\n\n`;
      msg += `▶️ /reanudar — Vuelvo a buscar oportunidades y a abrir posiciones.\n\n`;
      msg += `❓ /ayuda — Te vuelvo a mostrar esta lista cuando la necesites.`;
      return msg;
    }

    default:
      return `❓ Comando no reconocido: <code>${cmd}</code>\n\nUsa /ayuda para ver todos los comandos disponibles.`;
  }
}

/** Registra los handlers de comandos e inicia el polling de Telegram */
export function initTelegramCommands(): void {
  registerTelegramCommandHandler(async (input, _chatId) => {
    return handleMessage(input);
  });
  startTelegramPolling();
  console.log(TAG, "Comandos y chat de Telegram registrados — Tanit escucha mensajes libres");
}
