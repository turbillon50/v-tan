import { useState, useEffect } from "react";
import { Layout } from "@/components/layout";
import { BASE_URL } from "@/lib/api";

const GREEN = "#00D4AA";
const RED   = "#F23645";
const AMBER = "#FF9500";

const MODE_LABELS: Record<string, string> = {
  escalon: "Escalon",
  conservative: "Conservador", moderate: "Moderado", aggressive: "Agresivo",
  killer: "Killer", megalodon: "Megalodon",
};
const MODE_COLORS: Record<string, string> = {
  escalon: GREEN,
  conservative: GREEN, moderate: AMBER, aggressive: "#C084FC",
  killer: RED, megalodon: "#FF6B35",
};

const SYM: Record<string,string> = { BTCUSDT:"BTC",ETHUSDT:"ETH",SOLUSDT:"SOL",BNBUSDT:"BNB",XRPUSDT:"XRP",DOGEUSDT:"DOGE" };

function MiniEquityCurve({ data, delta }: { data: { time: number; balance: number }[]; delta: number }) {
  if (data.length < 2) return null;
  const min = Math.min(...data.map(h => h.balance));
  const max = Math.max(...data.map(h => h.balance));
  const range = max - min || 1;
  const color = delta >= 0 ? GREEN : RED;

  return (
    <div className="h-20 w-full relative">
      <svg viewBox={`0 0 ${data.length - 1} 100`} className="w-full h-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="eqGradFurt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d={data.map((h, i) => `${i === 0 ? "M" : "L"} ${i} ${100 - ((h.balance - min) / range) * 88 - 6}`).join(" ")}
          fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <path
          d={data.map((h, i) => `${i === 0 ? "M" : "L"} ${i} ${100 - ((h.balance - min) / range) * 88 - 6}`).join(" ") + ` L ${data.length - 1} 100 L 0 100 Z`}
          fill="url(#eqGradFurt)" />
      </svg>
      <div className="absolute bottom-0 left-1 text-[8px] font-mono text-muted-foreground/40">${min.toFixed(0)}</div>
      <div className="absolute top-0 right-1 text-[8px] font-mono text-muted-foreground/40">${max.toFixed(0)}</div>
    </div>
  );
}

function PosProgressBar({ pos, currentPrice }: { pos: any; currentPrice: number }) {
  if (!pos || !currentPrice) return null;
  const isLong = pos.side === "LONG";
  const sl = pos.stopLoss;
  const tp = pos.takeProfit;
  const entry = pos.entryPrice;
  const rangeMin = Math.min(sl, tp, entry, currentPrice);
  const rangeMax = Math.max(sl, tp, entry, currentPrice);
  const totalRange = rangeMax - rangeMin || 1;
  const pct = (v: number) => ((v - rangeMin) / totalRange) * 100;

  return (
    <div className="relative h-3 rounded-full bg-muted/30 overflow-visible mt-2 mb-1">
      <div className="absolute top-0 h-full rounded-full" style={{
        left: `${Math.min(pct(sl), pct(tp))}%`,
        width: `${Math.abs(pct(tp) - pct(sl))}%`,
        background: `linear-gradient(to right, ${RED}30, ${GREEN}30)`,
      }} />
      <div className="absolute top-0 w-0.5 h-full" style={{ left: `${pct(sl)}%`, background: RED }} />
      <div className="absolute top-0 w-0.5 h-full" style={{ left: `${pct(tp)}%`, background: GREEN }} />
      <div className="absolute top-0 w-0.5 h-full bg-white/30" style={{ left: `${pct(entry)}%` }} />
      <div className="absolute -top-0.5 w-2.5 h-4 rounded-sm" style={{
        left: `calc(${pct(currentPrice)}% - 5px)`,
        background: (isLong ? currentPrice >= entry : currentPrice <= entry) ? GREEN : RED,
      }} />
      <div className="flex justify-between mt-3.5 text-[7px] font-mono text-muted-foreground">
        <span style={{ color: RED }}>SL ${sl.toFixed(2)}</span>
        <span>Entrada ${entry.toFixed(2)}</span>
        <span style={{ color: GREEN }}>TP ${tp.toFixed(2)}</span>
      </div>
    </div>
  );
}

function useHoldTimer(openedAt: string | null) {
  const [elapsedSec, setElapsedSec] = useState(() =>
    openedAt ? Math.floor((Date.now() - new Date(openedAt).getTime()) / 1000) : 0
  );
  useEffect(() => {
    const t = setInterval(() => {
      setElapsedSec(openedAt ? Math.floor((Date.now() - new Date(openedAt).getTime()) / 1000) : 0);
    }, 1000);
    return () => clearInterval(t);
  }, [openedAt]);
  return elapsedSec;
}

function PositionCard({ pos, currentPrice, expanded, onToggle }: {
  pos: any; currentPrice: number; expanded: boolean; onToggle: () => void;
}) {
  const coin = SYM[pos.symbol] ?? pos.symbol.replace("USDT", "");
  const pnl = pos.unrealizedPnl ?? 0;
  const isLong = pos.side === "LONG";
  const sideColor = isLong ? GREEN : RED;
  const pnlColor = pnl >= 0 ? GREEN : RED;
  const pnlPct = pos.margin > 0 ? (pnl / pos.margin * 100) : 0;

  const elapsedSec = useHoldTimer(pos.openedAt ?? null);
  const holdMin = Math.floor(elapsedSec / 60);
  const holdSec = elapsedSec % 60;

  // Ventana máxima de hold: si existe maxHoldMs lo usamos, si no asumimos 20min
  const maxSec = pos.maxHoldMs ? Math.floor(pos.maxHoldMs / 1000) : 20 * 60;
  const remainSec = Math.max(0, maxSec - elapsedSec);
  const remainMin = Math.floor(remainSec / 60);
  const remainSecPart = remainSec % 60;
  const holdPct = Math.min(100, (elapsedSec / maxSec) * 100);
  const isNearExpiry = holdPct >= 80;
  const holdBarColor = holdPct >= 90 ? RED : holdPct >= 70 ? AMBER : GREEN;

  return (
    <div className="rounded-2xl border overflow-hidden transition-all"
      style={{ borderColor: sideColor + "40", background: sideColor + "06" }}>
      <button onClick={onToggle} className="w-full p-4 text-left">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-base" style={{ color: sideColor }}>{pos.side}</span>
            <span className="font-mono font-bold text-base text-foreground">{coin}</span>
            <span className="text-[10px] font-mono text-muted-foreground">{pos.leverage}x</span>
          </div>
          <div className="text-right">
            <div className="font-mono font-bold text-lg tabular-nums" style={{ color: pnlColor }}>
              {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
            </div>
            <div className="font-mono text-[10px] tabular-nums" style={{ color: pnlColor }}>
              {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
            </div>
          </div>
        </div>

        <PosProgressBar pos={pos} currentPrice={currentPrice} />

        <div className="flex items-center justify-between mt-4">
          <div className="font-mono text-xs text-muted-foreground">
            Precio actual: <span className="text-foreground font-bold">${currentPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          <div className="font-mono text-[10px] text-muted-foreground">
            {holdMin}m {holdSec}s
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3" style={{ borderColor: sideColor + "20" }}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Estrategia de Entrada</div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Score tecnico</span>
                  <span className="font-mono font-bold" style={{ color: (pos.signalScore ?? 50) < 35 ? GREEN : (pos.signalScore ?? 50) > 65 ? RED : AMBER }}>{pos.signalScore ?? "--"}/100</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Margen</span>
                  <span className="font-mono font-bold text-foreground">${pos.margin?.toFixed(2) ?? "0.00"}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Qty</span>
                  <span className="font-mono font-bold text-foreground">{pos.qty}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Fee entrada</span>
                  <span className="font-mono text-xs" style={{ color: RED }}>-${pos.entryFee?.toFixed(2)}</span>
                </div>
              </div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Gemini AI</div>
              {pos.geminiSentiment ? (
                <div className="space-y-1">
                  <div className="font-mono font-bold text-sm" style={{
                    color: pos.geminiSentiment === "BULLISH" ? GREEN : pos.geminiSentiment === "BEARISH" ? RED : AMBER
                  }}>
                    {pos.geminiSentiment}
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-relaxed">{pos.geminiReason ?? ""}</div>
                </div>
              ) : (
                <div className="text-[10px] text-muted-foreground">Sin datos AI al momento de entrada</div>
              )}
            </div>
          </div>
          {pos.signalReasons && pos.signalReasons.length > 0 && (
            <div>
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">Razones de la senal</div>
              <div className="flex flex-wrap gap-1">
                {pos.signalReasons.map((r: string, i: number) => (
                  <span key={i} className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-muted/30 text-muted-foreground border border-border">{r}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Furtivo() {
  const [bot, setBot] = useState<any>(null);
  const [expandedPos, setExpandedPos] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/status`);
        if (r.ok && !cancelled) setBot(await r.json());
      } catch {}
    };
    load();
    const id = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!bot) return (
    <Layout>
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-muted-foreground">Cargando...</div>
      </div>
    </Layout>
  );

  const isRunning = bot.active ?? false;
  const isLive2 = !!bot.liveMode;
  const balance = isLive2 ? (bot.liveBalance ?? 0) : (bot.effectiveBalance ?? bot.simBalance ?? 10000);
  const initialBal = isLive2 ? (bot.liveBalance ?? bot.initialBalance ?? 0) : (bot.initialBalance ?? 10000);
  const simBalance = bot.simBalance ?? 10000;
  const delta = balance - initialBal;
  const deltaPct = initialBal > 0 ? (delta / initialBal) * 100 : 0;
  const positions: any[] = Object.values(bot.openPositions ?? {});
  const tradeLog = bot.tradeLog ?? [];
  const tradesExecuted = bot.tradesExecuted ?? 0;
  const sessionPnl = bot.sessionPnl ?? 0;
  const totalFees = bot.totalFees ?? 0;
  const totalMargin = bot.margin ?? 0;
  const available = bot.available ?? simBalance;
  const balHistory = bot.balanceHistory ?? [];
  const modeColor = MODE_COLORS[bot.mode] ?? GREEN;
  const modeLabel = MODE_LABELS[bot.mode] ?? bot.mode;
  const currentPrices = bot.currentPrices ?? {};
  const lastSignals = bot.lastSignals ?? {};
  const geminiSentiment = bot.geminiSentiment;
  const geminiReason = bot.geminiReason;
  const lastScanAt = bot.lastScanAt ?? 0;

  const wins = tradeLog.filter((t: any) => t.pnl > 0).length;
  const losses = tradeLog.filter((t: any) => t.pnl < 0).length;
  const winRate = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : "--";
  const scanAgo = lastScanAt > 0 ? Math.floor((Date.now() - lastScanAt) / 1000) : null;
  const totalUnrealized = positions.reduce((s: number, p: any) => s + (p.unrealizedPnl ?? 0), 0);

  return (
    <Layout>
      <div className="space-y-4 pb-28 max-w-md mx-auto">

        <div className="flex items-center justify-between">
          <h1 className="font-display font-bold text-lg text-foreground">Monitor en Vivo</h1>
          <div className="flex items-center gap-2">
            {isRunning && (
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full" style={{ color: modeColor, background: modeColor + "15", border: `1px solid ${modeColor}30` }}>
                {modeLabel} {bot.leverage}x
              </span>
            )}
            <span className="text-[9px] font-mono font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">SANDBOX</span>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-muted-foreground">Capital Total</span>
            {isRunning && scanAgo !== null && (
              <span className="text-[9px] font-mono text-muted-foreground">Scan {scanAgo}s</span>
            )}
          </div>
          <div className="flex items-end justify-between">
            <div className="font-mono font-bold text-3xl tabular-nums text-foreground">
              ${balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            {delta !== 0 && (
              <div className="text-right">
                <div className="font-mono font-bold text-sm" style={{ color: delta >= 0 ? GREEN : RED }}>
                  {delta >= 0 ? "+" : ""}{delta.toFixed(2)}
                </div>
                <div className="font-mono text-[10px]" style={{ color: deltaPct >= 0 ? GREEN : RED }}>
                  {deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(2)}%
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4 mt-2 pt-2 border-t border-border">
            <div className="flex-1">
              <div className="text-[9px] text-muted-foreground">Disponible</div>
              <div className="font-mono font-bold text-sm text-foreground tabular-nums">${available.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </div>
            <div className="flex-1">
              <div className="text-[9px] text-muted-foreground">En operacion</div>
              <div className="font-mono font-bold text-sm tabular-nums" style={{ color: totalMargin > 0 ? AMBER : "#666" }}>${totalMargin.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </div>
            <div className="flex-1">
              <div className="text-[9px] text-muted-foreground">PnL abierto</div>
              <div className="font-mono font-bold text-sm tabular-nums" style={{ color: totalUnrealized >= 0 ? GREEN : RED }}>
                {totalUnrealized >= 0 ? "+" : ""}{totalUnrealized.toFixed(2)}
              </div>
            </div>
          </div>

          <MiniEquityCurve data={balHistory} delta={delta} />
        </div>

        {isRunning && (
          <div className="bg-card border border-border rounded-2xl p-3 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-primary" />
              <span className="text-xs font-semibold text-foreground">Cazando en 6 monedas</span>
              <span className="text-[10px] font-mono text-muted-foreground ml-auto">{positions.length}/10 pos</span>
            </div>
            {geminiSentiment && (
              <div className="text-[10px] font-mono" style={{ color: geminiSentiment === "BULLISH" ? GREEN : geminiSentiment === "BEARISH" ? RED : AMBER }}>
                Gemini AI: {geminiSentiment} {geminiReason ? `-- ${geminiReason}` : ""}
              </div>
            )}
            {bot.lastAction && (
              <div className="text-[10px] font-mono text-muted-foreground/60 leading-relaxed truncate">{bot.lastAction}</div>
            )}
          </div>
        )}

        {isRunning && Object.keys(currentPrices).length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(currentPrices).map(([s, p]) => {
              const sig = lastSignals[s];
              const hasPos = !!bot?.openPositions?.[s];
              const coin = SYM[s] ?? s.replace("USDT", "");
              const sigColor = sig?.direction === "LONG" ? GREEN : sig?.direction === "SHORT" ? RED : "#666";
              return (
                <div key={s} className={`bg-card border rounded-xl p-2 text-center ${hasPos ? "border-primary/40" : "border-border"}`}>
                  <div className="text-[9px] font-mono font-bold" style={{ color: hasPos ? GREEN : "#888" }}>{coin}</div>
                  <div className="font-mono font-bold text-xs text-foreground tabular-nums">
                    ${Number(p).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                  </div>
                  {sig && (
                    <div className="text-[8px] font-mono font-bold mt-0.5" style={{ color: sigColor }}>
                      {sig.direction === "NEUTRAL" ? "--" : sig.direction} {sig.score}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {positions.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-foreground">Posiciones Abiertas</h2>
              <span className="text-[10px] text-muted-foreground font-mono">Toca para ver estrategia</span>
            </div>
            {positions.map((pos: any) => (
              <PositionCard
                key={pos.symbol}
                pos={pos}
                currentPrice={currentPrices[pos.symbol] ?? pos.entryPrice}
                expanded={expandedPos === pos.symbol}
                onToggle={() => setExpandedPos(expandedPos === pos.symbol ? null : pos.symbol)}
              />
            ))}
          </div>
        )}

        {tradesExecuted > 0 && (
          <div className="grid grid-cols-5 gap-2">
            {[
              { label: "Trades", value: String(tradesExecuted), c: undefined },
              { label: "Wins", value: String(wins), c: GREEN },
              { label: "Losses", value: String(losses), c: RED },
              { label: "Win %", value: winRate + "%", c: parseFloat(winRate as string) >= 50 ? GREEN : RED },
              { label: "Fees", value: `-${totalFees.toFixed(1)}`, c: RED },
            ].map(s => (
              <div key={s.label} className="bg-card border border-border rounded-xl p-2 text-center">
                <div className="font-mono font-bold text-xs" style={{ color: s.c }}>{s.value}</div>
                <div className="text-[8px] text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {tradesExecuted > 0 && (
          <div className="bg-card border border-border rounded-xl p-3 flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">PnL Neto (despues de fees)</span>
            <span className="font-mono font-bold text-lg tabular-nums" style={{ color: sessionPnl >= 0 ? GREEN : RED }}>
              {sessionPnl >= 0 ? "+" : ""}{sessionPnl.toFixed(2)} USDT
            </span>
          </div>
        )}

        <div className="bg-card border border-border rounded-2xl p-4">
          <h2 className="text-xs font-semibold text-foreground mb-3">Historial de Operaciones</h2>
          {tradeLog.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground">Sin operaciones</p>
              <p className="text-[10px] text-muted-foreground mt-1">
                {isRunning ? "El motor esta escaneando..." : "Inicia el bot desde Panel"}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5 max-h-80 overflow-y-auto">
              {tradeLog.map((t: any, i: number) => (
                <div key={i} className="flex items-center justify-between px-3 py-2 rounded-xl bg-muted/10 border border-border">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-xs" style={{ color: t.side === "LONG" ? GREEN : RED }}>{t.side}</span>
                      <span className="font-mono text-xs text-foreground">{SYM[t.symbol] ?? t.symbol}</span>
                      <span className="text-[9px] text-muted-foreground font-mono">
                        {new Date(t.closedAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <div className="text-[9px] text-muted-foreground mt-0.5 font-mono">
                      ${t.entryPrice?.toFixed(2)} -- ${t.exitPrice?.toFixed(2)} · fee: ${t.fee?.toFixed(2)} · {t.reason}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-bold text-sm tabular-nums" style={{ color: t.pnl >= 0 ? GREEN : RED }}>
                      {t.pnl >= 0 ? "+" : ""}{t.pnl?.toFixed(2)}
                    </div>
                    {t.grossPnl !== undefined && t.grossPnl !== t.pnl && (
                      <div className="font-mono text-[8px] text-muted-foreground">
                        bruto: {t.grossPnl >= 0 ? "+" : ""}{t.grossPnl?.toFixed(2)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {!isRunning && tradesExecuted === 0 && (
          <div className="bg-card border border-primary/20 rounded-2xl p-5 text-center">
            <p className="text-sm font-semibold text-foreground">Listo para operar</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              Ve a <strong>Panel</strong> y presiona <strong className="text-primary">Soltar</strong>
            </p>
          </div>
        )}

      </div>
    </Layout>
  );
}
