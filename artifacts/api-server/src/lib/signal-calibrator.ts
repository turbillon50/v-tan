/**
 * signal-calibrator.ts
 * Calibración automática de pesos de señal basada en historial causal.
 * Aprende de los últimos 50 trades cerrados para ajustar multiplicadores.
 *
 * Re-exporta las funciones de db-persistence para mantener separación de responsabilidades
 * y cumplir con la interfaz requerida del módulo.
 */

export {
  getCalibrationWeights,
  getSimilarContextWinRate,
  type CalibrationWeights,
} from "./db-persistence";

/** Multiplica el bonus base por el peso de calibración, solo si hay ≥5 trades del tipo */
export function applyCalibrationWeight(
  baseBonus: number,
  count: number,
  weight: number,
  minCount = 5
): number {
  if (count < minCount) return baseBonus;
  return baseBonus * weight;
}

/** Formatea los pesos de calibración como string legible para el prompt de Tanit */
export function formatCalibrationForPrompt(cal: import("./db-persistence").CalibrationWeights): string {
  if (cal.totalTrades < 5) {
    return "=== CALIBRACIÓN DE SEÑALES ===\nSin suficientes datos aún (mín 5 trades con contexto causal)";
  }
  return (
    `=== CALIBRACIÓN DE SEÑALES (aprendizaje causal — últimos ${cal.totalTrades} trades) ===\n` +
    `📰 Noticias: WR=${cal.news.winRate.toFixed(0)}% peso=${cal.news.weight.toFixed(2)}x (n=${cal.news.count})\n` +
    `📊 Breakout: WR=${cal.breakout.winRate.toFixed(0)}% peso=${cal.breakout.weight.toFixed(2)}x (n=${cal.breakout.count})\n` +
    `📉 RSI Div:  WR=${cal.rsiDiv.winRate.toFixed(0)}% peso=${cal.rsiDiv.weight.toFixed(2)}x (n=${cal.rsiDiv.count})\n` +
    `🚩 Flag:     WR=${cal.flag.winRate.toFixed(0)}% peso=${cal.flag.weight.toFixed(2)}x (n=${cal.flag.count})`
  );
}
