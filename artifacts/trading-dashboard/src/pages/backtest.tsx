import { useState } from "react";
import { Layout } from "@/components/layout";
import { FlaskIcon, PlayBtn, UpArrow, DownArrow, BarChartIcon, AwardIcon, TargetIcon, ZapIcon, ShieldIcon, RocketIcon, AlertIcon } from "@/components/TradeIcons";
import { BASE_URL } from "@/lib/api";

const SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT","DOGEUSDT","ADAUSDT","DOTUSDT","AVAXUSDT","LINKUSDT"];
const DAYS_OPTIONS = [7, 14, 30];

interface ModeResult {
  mode: string; totalTrades: number; winRate: number; totalPnl: number;
  avgWin: number; avgLoss: number; profitFactor: number; maxDrawdown: number;
  bestTrade: number; worstTrade: number; currentStreak: number;
  trades: { time: number; direction: string; pnl: number; score: number }[];
}
interface BacktestResult { symbol: string; days: number; modes: ModeResult[] }

const MODE_META: Record<string, { label: string; emoji: string; color: string; border: string; bg: string }> = {
  conservative: { label: "Conservador", emoji: "🛡️", color: "text-blue-400",   border: "border-blue-500/30",   bg: "bg-blue-500/5" },
  risky:        { label: "Arriesgado",  emoji: "⚡", color: "text-amber-400",  border: "border-amber-500/30",  bg: "bg-amber-500/5" },
  ultra:        { label: "Ultra",       emoji: "🚀", color: "text-purple-400", border: "border-purple-500/30", bg: "bg-purple-500/5" },
  tiburon:      { label: "Tiburón",     emoji: "🦈", color: "text-[#F23645]",    border: "border-[#F23645]/25",    bg: "bg-[#F23645]/5" },
};

function pct(n: number) { return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`; }
function cls(n: number) { return n >= 0 ? "text-[#00D4AA]" : "text-[#F23645]"; }

export default function Backtest() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [days, setDays]     = useState(7);
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState<BacktestResult | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  async function runBacktest() {
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await fetch(`${BASE_URL}api/backtest/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, days }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error en el servidor");
      setResult(data as BacktestResult);
      setSelected(0);
    } catch (e: any) {
      setError(e.message ?? "Error desconocido");
    } finally {
      setLoading(false);
    }
  }

  const mode = result?.modes?.[selected];

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <FlaskIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold text-foreground">Backtest Engine</h1>
            <p className="text-sm text-muted-foreground">Prueba la estrategia en datos históricos reales</p>
          </div>
        </div>

        {/* Controls */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h2 className="font-semibold text-sm text-foreground">Configuración de la simulación</h2>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {/* Symbol */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Símbolo</label>
              <select
                value={symbol} onChange={e => setSymbol(e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-primary/50">
                {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* Days */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Período</label>
              <select
                value={days} onChange={e => setDays(Number(e.target.value))}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-primary/50">
                {DAYS_OPTIONS.map(d => <option key={d} value={d}>{d} días</option>)}
              </select>
            </div>

            {/* Run */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">&nbsp;</label>
              <button
                onClick={runBacktest} disabled={loading}
                className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground font-semibold rounded-lg py-2 px-4 text-sm transition-all hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                    Simulando...
                  </>
                ) : (
                  <><PlayBtn className="w-4 h-4" /> Ejecutar Backtest</>
                )}
              </button>
            </div>
          </div>

          <div className="text-xs text-muted-foreground/60 leading-relaxed">
            Simula los 4 modos usando señales históricas reales de Bybit. Compara rendimiento, win rate y factor de beneficio por modo.
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-[#F23645]/8 border border-[#F23645]/25 rounded-xl p-4 flex items-start gap-3">
            <AlertIcon className="w-4 h-4 text-[#F23645] mt-0.5 shrink-0" />
            <p className="text-sm text-[#F23645]/80">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            {/* Mode tabs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {result.modes.map((m, i) => {
                const meta = MODE_META[m.mode] ?? MODE_META.conservative;
                const isActive = i === selected;
                return (
                  <button key={m.mode} onClick={() => setSelected(i)}
                    className={`rounded-xl border p-3 text-left transition-all ${
                      isActive ? `${meta.bg} ${meta.border} ring-1 ring-inset ${meta.border}` : "border-border bg-card hover:border-border/80"
                    }`}>
                    <div className="text-xl mb-1">{meta.emoji}</div>
                    <div className={`text-xs font-bold ${isActive ? meta.color : "text-muted-foreground"}`}>{meta.label}</div>
                    <div className={`text-lg font-mono font-bold mt-1 ${cls(m.totalPnl)}`}>{pct(m.totalPnl)}</div>
                    <div className="text-[10px] text-muted-foreground">{m.winRate.toFixed(0)}% win rate</div>
                  </button>
                );
              })}
            </div>

            {/* Detail */}
            {mode && (() => {
              const meta = MODE_META[mode.mode] ?? MODE_META.conservative;
              return (
                <div className={`rounded-xl border ${meta.border} ${meta.bg} p-5 space-y-5`}>
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{meta.emoji}</span>
                    <div>
                      <h3 className={`font-display text-lg font-bold ${meta.color}`}>Modo {meta.label}</h3>
                      <p className="text-xs text-muted-foreground">{result.symbol} • {result.days} días de simulación</p>
                    </div>
                  </div>

                  {/* Stats grid */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { icon: BarChartIcon, label: "Total Trades",    val: String(mode.totalTrades),       color: "text-foreground" },
                      { icon: TargetIcon,   label: "Win Rate",         val: `${mode.winRate.toFixed(1)}%`,  color: mode.winRate > 50 ? "text-[#00C9A7]" : "text-[#F23645]" },
                      { icon: UpArrow,      label: "PnL Total",        val: pct(mode.totalPnl),             color: cls(mode.totalPnl) },
                      { icon: AwardIcon,    label: "Profit Factor",    val: mode.profitFactor.toFixed(2),   color: mode.profitFactor > 1.5 ? "text-[#00C9A7]" : mode.profitFactor > 1 ? "text-amber-400" : "text-[#F23645]" },
                      { icon: UpArrow,      label: "Avg Win",          val: pct(mode.avgWin),               color: "text-[#00C9A7]" },
                      { icon: DownArrow,    label: "Avg Loss",         val: pct(mode.avgLoss),              color: "text-[#F23645]" },
                      { icon: ShieldIcon,   label: "Max Drawdown",     val: pct(-Math.abs(mode.maxDrawdown)), color: "text-[#F23645]" },
                      { icon: ZapIcon,      label: "Racha Actual",     val: `${mode.currentStreak > 0 ? "+" : ""}${mode.currentStreak}`, color: mode.currentStreak > 0 ? "text-[#00C9A7]" : "text-[#F23645]" },
                    ].map(({ icon: Icon, label, val, color }) => (
                      <div key={label} className="bg-background/50 rounded-lg p-3 border border-border/50">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{label}</span>
                        </div>
                        <div className={`text-lg font-mono font-bold ${color}`}>{val}</div>
                      </div>
                    ))}
                  </div>

                  {/* Best / Worst */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[#00D4AA]/5 border border-[#00D4AA]/20 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <RocketIcon className="w-3.5 h-3.5 text-[#00D4AA]" />
                        <span className="text-xs text-muted-foreground font-semibold">Mejor Trade</span>
                      </div>
                      <div className="text-2xl font-mono font-bold text-[#00D4AA]">{pct(mode.bestTrade)}</div>
                    </div>
                    <div className="bg-[#F23645]/5 border border-[#F23645]/20 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <DownArrow className="w-3.5 h-3.5 text-[#F23645]" />
                        <span className="text-xs text-muted-foreground font-semibold">Peor Trade</span>
                      </div>
                      <div className="text-2xl font-mono font-bold text-[#F23645]">{pct(mode.worstTrade)}</div>
                    </div>
                  </div>

                  {/* Trade list */}
                  {mode.trades && mode.trades.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Últimos trades simulados</h4>
                      <div className="space-y-1.5 max-h-60 overflow-y-auto scrollbar-none">
                        {mode.trades.slice(-15).reverse().map((t, i) => (
                          <div key={i} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-background/40 border border-border/30 text-xs">
                            <div className="flex items-center gap-2">
                              <span className={`font-semibold ${t.direction === "LONG" ? "text-[#00D4AA]" : "text-[#F23645]"}`}>{t.direction}</span>
                              <span className="text-muted-foreground font-mono">{new Date(t.time).toLocaleDateString("es-MX", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-muted-foreground text-[10px]">Score {t.score}</span>
                              <span className={`font-mono font-bold ${cls(t.pnl)}`}>{pct(t.pnl)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Comparison bar */}
            <div className="bg-card border border-border rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-foreground">Comparación de PnL — {result.days} días</h3>
              {result.modes.map(m => {
                const meta = MODE_META[m.mode] ?? MODE_META.conservative;
                const pnlAbs = Math.abs(m.totalPnl);
                const maxPnl = Math.max(...result.modes.map(x => Math.abs(x.totalPnl)));
                const pct2 = maxPnl > 0 ? (pnlAbs / maxPnl) * 100 : 0;
                return (
                  <div key={m.mode} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className={meta.color}>{meta.emoji} {meta.label}</span>
                      <span className={`font-mono font-bold ${cls(m.totalPnl)}`}>{pct(m.totalPnl)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted/30 overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-700 ${m.totalPnl >= 0 ? "bg-[#00D4AA]" : "bg-[#F23645]"}`}
                        style={{ width: `${pct2}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Idle state */}
        {!result && !loading && !error && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-primary/5 border border-primary/15 flex items-center justify-center">
              <FlaskIcon className="w-8 h-8 text-primary/40" />
            </div>
            <div>
              <p className="text-foreground font-semibold">Selecciona símbolo y período</p>
              <p className="text-sm text-muted-foreground mt-1">Presiona "Ejecutar Backtest" para simular los 4 modos y ver cuál habría funcionado mejor</p>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
