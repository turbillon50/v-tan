import { useState, useEffect } from "react";
import { Layout } from "@/components/layout";
import { BASE_URL } from "@/lib/api";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";

const GREEN  = "#00E5CC";
const RED    = "#F23645";
const AMBER  = "#FF9500";
const DIM    = "#8892A4";

const fmt    = (n: number, d = 2) => n == null ? "--" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUSD = (n: number, d = 2) => "$" + fmt(n, d);
const pctClr = (v: number) => v >= 0 ? GREEN : RED;
const pctTxt = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

const ORANGE = "#F7931A"; // Bitcoin orange

export default function Capital() {
  const [bot, setBot] = useState<any>(null);
  const [btc, setBtc] = useState<any>(null);
  const [converting, setConverting] = useState(false);
  const [convertMsg, setConvertMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/status`);
        if (r.ok && !cancelled) setBot(await r.json());
      } catch {}
    };
    load();
    const id = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Cargar saldo BTC periódicamente
  useEffect(() => {
    let cancelled = false;
    const loadBtc = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/btc-balance`);
        if (r.ok && !cancelled) setBtc(await r.json());
      } catch {}
    };
    loadBtc();
    const id = setInterval(loadBtc, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const handleConvertBtc = async (accountType: string) => {
    setConverting(true);
    setConvertMsg(null);
    try {
      const r = await fetch(`${BASE_URL}api/bot/convert-btc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountType }),
      });
      const d = await r.json();
      if (d.ok) {
        setConvertMsg(d.msg);
        // Refrescar BTC balance
        const rb = await fetch(`${BASE_URL}api/bot/btc-balance`);
        if (rb.ok) setBtc(await rb.json());
      } else {
        setConvertMsg("❌ " + (d.error ?? "Error desconocido"));
      }
    } catch (e) {
      setConvertMsg("❌ Error de conexión");
    } finally {
      setConverting(false);
    }
  };

  const isLive   = !!bot?.liveMode;
  const initial  = isLive ? (bot?.liveInitialBalance ?? bot?.initialBalance ?? 0) : (bot?.initialBalance ?? 0);
  const current  = isLive ? (bot?.liveBalance ?? 0) : (bot?.effectiveBalance ?? bot?.simBalance ?? 0);
  const margin   = bot?.margin ?? 0;
  const available = isLive ? (bot?.liveAvailable ?? current) : (bot?.available ?? current);
  const totalFees = bot?.totalFees ?? 0;
  const posCount  = bot?.positionCount ?? 0;
  const tradeLog  = bot?.tradeLog ?? [];
  const history: { time: number; balance: number }[] = bot?.balanceHistory ?? [];

  const gain    = current - initial;
  const gainPct = initial > 0 ? (gain / initial) * 100 : 0;

  const wins      = tradeLog.filter((t: any) => t.pnl > 0).length;
  const losses    = tradeLog.filter((t: any) => t.pnl < 0).length;
  const winRate   = tradeLog.length > 0 ? ((wins / tradeLog.length) * 100) : 0;
  const totalPnl  = tradeLog.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0);
  const avgWin    = wins  > 0 ? tradeLog.filter((t: any) => t.pnl > 0).reduce((s: number, t: any) => s + t.pnl, 0) / wins  : 0;
  const avgLoss   = losses > 0 ? tradeLog.filter((t: any) => t.pnl < 0).reduce((s: number, t: any) => s + t.pnl, 0) / losses : 0;
  const bestTrade = tradeLog.length > 0 ? Math.max(...tradeLog.map((t: any) => t.pnl ?? 0)) : 0;
  const worstTrade = tradeLog.length > 0 ? Math.min(...tradeLog.map((t: any) => t.pnl ?? 0)) : 0;
  const profitFactor = losses > 0
    ? tradeLog.filter((t: any) => t.pnl > 0).reduce((s: number, t: any) => s + t.pnl, 0) /
      Math.abs(tradeLog.filter((t: any) => t.pnl < 0).reduce((s: number, t: any) => s + t.pnl, 0))
    : wins > 0 ? 999 : 0;

  const chartData = history.map((h, i) => ({
    idx: i,
    balance: h.balance,
    t: new Date(h.time).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }),
  }));

  const ChartTip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div className="bg-[#081018] border border-[#00E5CC]/20 rounded-lg px-3 py-2 text-xs font-mono shadow-xl">
        <div className="text-[#8892A4] mb-0.5">{d.t}</div>
        <div className="font-bold" style={{ color: GREEN }}>{fmtUSD(d.balance)}</div>
      </div>
    );
  };

  const sorted = [...tradeLog].reverse().slice(0, 30);

  return (
    <Layout>
      <div className="space-y-5 max-w-5xl">

        {/* ── Header ── */}
        <div>
          <h1 className="font-display text-xl font-bold text-foreground tracking-tight">Capital &amp; Rendimiento</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Balance real · historial de operaciones · métricas de la estrategia</p>
        </div>

        {/* ── Panel BTC → USDT ── */}
        <div style={{ background: "#0a0d14", border: `1px solid ${ORANGE}40`, borderRadius: 16, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px 12px", borderBottom: `1px solid ${ORANGE}20` }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: ORANGE, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 900, color: "#fff" }}>₿</div>
            <div>
              <div style={{ fontFamily: "var(--app-font-mono)", fontWeight: 900, fontSize: 13, color: ORANGE, letterSpacing: "0.05em" }}>DEPÓSITO BITCOIN</div>
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM }}>Convierte tu BTC a USDT con un clic · sin banco</div>
            </div>
          </div>

          <div style={{ padding: "14px 18px" }}>
            {/* Saldos por cuenta */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
              {[
                { label: "SPOT", key: "spotBtc" },
                { label: "FUND", key: "fundBtc" },
                { label: "UNIFIED", key: "unifiedBtc" },
              ].map(({ label, key }) => {
                const val = btc?.[key] ?? 0;
                const hasBalance = val > 0;
                return (
                  <div key={key} style={{ background: hasBalance ? `${ORANGE}15` : "#081018", border: `1px solid ${hasBalance ? ORANGE + "60" : "#1a2236"}`, borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM, marginBottom: 4 }}>{label}</div>
                    <div style={{ fontFamily: "var(--app-font-mono)", fontWeight: 900, fontSize: 13, color: hasBalance ? ORANGE : "#2a3a52" }}>
                      {btc ? (val > 0 ? val.toFixed(6) : "0.000000") : "—"}
                    </div>
                    <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, color: DIM }}>BTC</div>
                    {hasBalance && (
                      <button
                        onClick={() => void handleConvertBtc(label)}
                        disabled={converting}
                        style={{
                          marginTop: 8, width: "100%",
                          background: converting ? "#1a2236" : `linear-gradient(135deg, ${ORANGE} 0%, #e07b00 100%)`,
                          border: "none", borderRadius: 7, padding: "6px 0",
                          fontFamily: "var(--app-font-mono)", fontWeight: 900, fontSize: 10, color: "#fff",
                          cursor: converting ? "not-allowed" : "pointer",
                          boxShadow: converting ? "none" : `0 0 12px ${ORANGE}50`,
                        }}
                      >
                        {converting ? "..." : "₿ → USDT"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Total BTC */}
            {btc && btc.total > 0 && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: `${ORANGE}10`, border: `1px solid ${ORANGE}40`, borderRadius: 10, padding: "10px 14px", marginBottom: 12 }}>
                <div>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM }}>TOTAL BTC DETECTADO</div>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontWeight: 900, fontSize: 16, color: ORANGE }}>{btc.total.toFixed(6)} BTC</div>
                </div>
                <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM, textAlign: "right" }}>
                  Presiona el botón<br/>de la cuenta correcta
                </div>
              </div>
            )}

            {!btc || btc.total === 0 ? (
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: DIM, textAlign: "center", padding: "8px 0" }}>
                Sin BTC detectado — deposita en Bybit y aparecerá aquí automáticamente
              </div>
            ) : null}

            {/* Resultado de la conversión */}
            {convertMsg && (
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, color: convertMsg.startsWith("❌") ? RED : GREEN, background: convertMsg.startsWith("❌") ? `${RED}15` : `${GREEN}15`, border: `1px solid ${convertMsg.startsWith("❌") ? RED : GREEN}40`, borderRadius: 8, padding: "10px 14px", marginTop: 8, textAlign: "center" }}>
                {convertMsg}
              </div>
            )}
          </div>
        </div>

        {/* ── 4 KPIs ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Capital inicial */}
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Inicial</div>
            <div className="text-xl font-bold font-mono tabular-nums text-foreground">{fmtUSD(initial)}</div>
            <div className="text-[10px] text-muted-foreground mt-1">Punto de partida</div>
          </div>

          {/* Capital actual */}
          <div className="bg-card border border-border rounded-xl p-4" style={{ borderColor: pctClr(gain) + "40" }}>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Actual</div>
            <div className="text-xl font-bold font-mono tabular-nums" style={{ color: GREEN }}>{fmtUSD(current)}</div>
            <div className="text-[10px] font-mono mt-1" style={{ color: pctClr(gainPct) }}>
              {pctTxt(gainPct)} ({gain >= 0 ? "+" : ""}{fmtUSD(gain)})
            </div>
          </div>

          {/* En operación */}
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">En Posición</div>
            <div className="text-xl font-bold font-mono tabular-nums" style={{ color: margin > 0 ? AMBER : DIM }}>
              {fmtUSD(margin)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">{posCount}/3 pos · {fmtUSD(available)} libre</div>
          </div>

          {/* Win rate */}
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Win Rate</div>
            <div className="text-xl font-bold font-mono tabular-nums" style={{ color: winRate >= 50 ? GREEN : RED }}>
              {tradeLog.length > 0 ? winRate.toFixed(1) + "%" : "—"}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">{wins}W · {losses}L · {tradeLog.length} ops</div>
          </div>
        </div>

        {/* ── Curva de capital ── */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="font-display font-bold text-sm text-foreground">Curva de Capital</h2>
              <p className="text-[10px] text-muted-foreground">Evolución del balance trade a trade</p>
            </div>
            {chartData.length > 1 && (
              <div className="text-right">
                <div className="text-xs font-mono font-bold" style={{ color: pctClr(gainPct) }}>{pctTxt(gainPct)}</div>
                <div className="text-[10px] text-muted-foreground">{chartData.length} puntos</div>
              </div>
            )}
          </div>
          {chartData.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="capGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={GREEN} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="t" tick={{ fill: DIM, fontSize: 9, fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: DIM, fontSize: 9, fontFamily: "JetBrains Mono" }} tickLine={false} axisLine={false} domain={["auto","auto"]} tickFormatter={v => "$" + fmt(v, 0)} width={72} />
                <Tooltip content={<ChartTip />} />
                <Area type="monotone" dataKey="balance" stroke={GREEN} strokeWidth={1.5} fill="url(#capGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-36 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground">
              <div className="text-2xl opacity-20">📈</div>
              <div className="text-xs">El bot aún no ha cerrado operaciones</div>
            </div>
          )}
        </div>

        {/* ── Stats clave ── */}
        {tradeLog.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "PnL Neto",       value: (totalPnl >= 0 ? "+" : "") + fmtUSD(totalPnl),    color: pctClr(totalPnl) },
              { label: "Profit Factor",  value: profitFactor >= 999 ? "∞" : profitFactor.toFixed(2), color: profitFactor >= 1.5 ? GREEN : profitFactor >= 1 ? AMBER : RED },
              { label: "Ganancia Prom",  value: "+" + fmtUSD(avgWin),   color: GREEN },
              { label: "Pérdida Prom",   value: fmtUSD(avgLoss),         color: RED  },
              { label: "Mejor Trade",    value: "+" + fmtUSD(bestTrade), color: GREEN },
              { label: "Peor Trade",     value: fmtUSD(worstTrade),      color: RED  },
              { label: "Fees Pagados",   value: "-" + fmtUSD(totalFees), color: RED  },
              { label: "Neto Real",      value: (totalPnl - totalFees >= 0 ? "+" : "") + fmtUSD(totalPnl - totalFees), color: pctClr(totalPnl - totalFees) },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-card border border-border rounded-xl p-3">
                <div className="text-[9px] text-muted-foreground uppercase tracking-widest mb-1">{label}</div>
                <div className="text-base font-bold font-mono tabular-nums" style={{ color }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Historial de operaciones ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="font-display font-bold text-sm text-foreground">Historial de Operaciones</h2>
              <p className="text-[10px] text-muted-foreground">Últimas 30 operaciones cerradas</p>
            </div>
            {tradeLog.length > 0 && (
              <div className="text-[10px] text-muted-foreground font-mono">{tradeLog.length} total</div>
            )}
          </div>
          {sorted.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-xs">
              Sin operaciones cerradas aún — el bot está activo y analizando
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border">
                    {["Par","Dir","Precio","PnL","PnL%","Leverage","Cierre"].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-[9px] uppercase tracking-widest text-muted-foreground font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((t: any, i: number) => {
                    const pnl     = t.pnl ?? 0;
                    const pnlPct  = t.pnlPercent ?? 0;
                    const isWin   = pnl >= 0;
                    const side    = t.side ?? t.direction;
                    const isLong  = side === "Buy" || side === "LONG";
                    const closedAt = t.closedAt ? new Date(t.closedAt).toLocaleString("es", {
                      month: "2-digit", day: "2-digit",
                      hour: "2-digit", minute: "2-digit",
                    }) : "—";
                    return (
                      <tr key={t.id ?? i} className="border-b border-border/40 hover:bg-white/[0.02] transition-colors">
                        <td className="px-3 py-2.5 text-foreground font-semibold whitespace-nowrap">
                          {(t.symbol ?? "").replace("USDT", "")}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase" style={{
                            background: isLong ? GREEN + "20" : RED + "20",
                            color: isLong ? GREEN : RED,
                          }}>
                            {isLong ? "LONG" : "SHORT"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                          {t.entryPrice ? fmtUSD(t.entryPrice, 4) : "—"}
                        </td>
                        <td className="px-3 py-2.5 font-bold whitespace-nowrap" style={{ color: isWin ? GREEN : RED }}>
                          {isWin ? "+" : ""}{fmtUSD(pnl)}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: isWin ? GREEN : RED }}>
                          {isWin ? "+" : ""}{pnlPct.toFixed(2)}%
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                          {t.leverage ?? "—"}x
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground text-[10px] whitespace-nowrap">{closedAt}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </Layout>
  );
}
