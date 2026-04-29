import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { BASE_URL } from "@/lib/api";
import { useBotStatus } from "@/contexts/TradingModeContext";
import {
  AreaChart, Area, ResponsiveContainer, Tooltip,
} from "recharts";

const TEAL   = "#0ECB81";
const RED    = "#F6465D";
const ROSE   = RED;
const AMBER  = "#F5A623";
const WHITE  = "#FFFFFF";
const DIM    = "#7a8ba8";
const MID    = "#a8b6cc";
const SOFT   = "#c8d4e0";
const DEEP   = "#080c14";
const LINE   = "#1a2433";
const BG_WIN = "#041a0f";
const BG_LOSS= "#160408";
const BDR_WIN= "#0a3020";
const BDR_LSS= "#300810";

const CAPITAL_STEPS = [10, 25, 50, 75, 100];

const SYM: Record<string, string> = {
  BTCUSDT:"BTC", ETHUSDT:"ETH", SOLUSDT:"SOL",
  BNBUSDT:"BNB", XRPUSDT:"XRP", DOGEUSDT:"DOGE",
  AVAXUSDT:"AVAX", LINKUSDT:"LINK",
};

function px(p?: number) {
  if (p == null) return "—";
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return "$" + p.toFixed(4);
  return "$" + p.toFixed(5);
}

interface OISummaryItem {
  symbol: string;
  coin: string;
  openInterest: number;
  openInterestValue: number;
  delta4h: number;
  arrow: "up" | "down" | "flat";
}

interface OISummaryData {
  symbols: OISummaryItem[];
  updatedAt: number;
  demo?: boolean;
}

function fmtOI(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000)     return (v / 1_000).toFixed(1) + "K";
  return v.toFixed(0);
}

function holdDur(m?: number) {
  if (!m && m !== 0) return "";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}

function timeAgo(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

const REASON: Record<string, { label: string; bg: string; text: string }> = {
  "Take Profit": { label: "TP",      bg: TEAL,     text: "#020d09" },
  "Stop Loss":   { label: "SL",      bg: ROSE,     text: WHITE },
  "Flip":        { label: "FLIP",    bg: AMBER,    text: "#0a0500" },
  "Bot detenido":{ label: "STOP",    bg: DIM,      text: WHITE },
  "Tiempo":      { label: "TIME",    bg: DIM,      text: WHITE },
  "MP Take":     { label: "MP·TP",   bg: "#7090ff",text: "#020820" },
  "MP Stop":     { label: "MP·SL",   bg: ROSE,     text: WHITE },
  "MP TIMEOUT":  { label: "MP·TO",   bg: DIM,      text: WHITE },
};
function getReason(r: string) {
  const k = Object.keys(REASON).find(k => r?.includes(k));
  return k ? REASON[k] : { label: "—", bg: "#222", text: WHITE };
}

const Label = ({ children, color = DIM }: { children: React.ReactNode; color?: string }) => (
  <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, letterSpacing:"0.18em", textTransform:"uppercase" as const, color, fontWeight:500 }}>
    {children}
  </div>
);

const REGIME_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  trending:   { label: "TRENDING",    color: TEAL,     bg: "rgba(0,229,204,0.08)" },
  lateral:    { label: "LATERAL",     color: "#7090ff", bg: "rgba(112,144,255,0.08)" },
  transition: { label: "TRANSICIÓN",  color: AMBER,    bg: "rgba(255,149,0,0.08)" },
};

/* ── tiny sparkline tooltip ── */
const SparkTip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background:"rgba(4,12,20,0.92)", border:"1px solid rgba(0,229,204,0.25)",
      borderRadius:8, padding:"5px 10px", fontFamily:"var(--app-font-mono)",
      fontSize:10, color:TEAL, whiteSpace:"nowrap",
    }}>
      ${d.balance.toFixed(2)}
      <span style={{ color:DIM, marginLeft:6 }}>{d.t}</span>
    </div>
  );
};

export default function Simple() {
  const [, navigate] = useLocation();
  const { bot, isLive: liveMode, refresh } = useBotStatus();
  const [capitalPct, setCapitalPct]     = useState(100);
  const [toggling, setToggling]         = useState(false);
  const [showLive, setShowLive]         = useState(false);
  const [wantLive, setWantLive]         = useState(false);
  const [showReset, setShowReset]       = useState(false);
  const [resetting, setResetting]       = useState(false);
  const [closingPos, setClosingPos]     = useState<string | null>(null);
  const [closingBybit, setClosingBybit] = useState<string | null>(null);
  const [bybitPositions, setBybitPositions] = useState<any[]>([]);
  const [flashMsg, setFlashMsg]         = useState<string | null>(null);
  const [syncingBal, setSyncingBal]     = useState(false);
  const [oiData, setOiData]             = useState<OISummaryData | null>(null);
  const initedCapital = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  useEffect(() => {
    if (!initedCapital.current && bot?.capitalPercent) {
      setCapitalPct(bot.capitalPercent);
      initedCapital.current = true;
    }
  }, [bot?.capitalPercent]);

  const initedLive = useRef(false);
  useEffect(() => {
    if (!initedLive.current && bot != null) {
      setWantLive(bot.liveMode ?? false);
      initedLive.current = true;
    }
  }, [bot?.liveMode]);

  useEffect(() => {
    const fetchBybit = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/bybit-positions`);
        if (r.ok) { const d = await r.json(); setBybitPositions(d.positions ?? []); }
      } catch {}
    };
    fetchBybit();
    const id = setInterval(fetchBybit, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/market/oi-summary`);
        if (r.ok) setOiData(await r.json());
      } catch {}
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const syncBalance = async () => {
    if (syncingBal) return;
    setSyncingBal(true);
    try {
      const r = await fetch(`${BASE_URL}api/bot/sync-balance`, { method: "POST" });
      const d = await r.json();
      if (d.ok) setFlashMsg(`✓ Balance actualizado: $${d.balance.toFixed(2)} USDT`);
      else setFlashMsg("⚠ No se pudo sincronizar");
    } catch { setFlashMsg("⚠ Error de conexión"); }
    finally { setSyncingBal(false); setTimeout(() => setFlashMsg(null), 3000); }
  };

  const isRunning  = bot?.active ?? false;
  const hybrid     = bot?.hybrid ?? null;
  const regime     = hybrid?.regime ?? "transition";
  const regimeInfo = REGIME_LABELS[regime] ?? REGIME_LABELS.transition;
  const balance    = liveMode ? (bot?.liveBalance ?? 0) : (bot?.effectiveBalance ?? bot?.simBalance ?? 10000);
  const initialBal = liveMode ? (bot?.liveInitialBalance ?? bot?.initialBalance ?? 0) : (bot?.initialBalance ?? 10000);
  const delta      = balance - initialBal;
  const deltaPct   = initialBal > 0 ? (delta / initialBal * 100) : 0;
  const positions: any[] = Object.values(bot?.openPositions ?? {});
  const tradeLog   = bot?.tradeLog ?? [];
  const sessionPnl = bot?.sessionPnl ?? 0;
  const totalFees  = bot?.totalFees ?? 0;
  const totalUnreal= positions.reduce((s: number, p: any) => s + (p.unrealizedPnl ?? 0), 0);
  const prices     = bot?.currentPrices ?? {};
  const scanAt     = bot?.lastScanAt ?? 0;
  const scanAgo    = scanAt > 0 ? Math.floor((now - scanAt) / 1000) : null;
  const wins       = tradeLog.filter((t: any) => t.pnl > 0).length;
  const losses     = tradeLog.filter((t: any) => t.pnl < 0).length;
  const winRate    = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0;
  const escalera   = bot?.escalera ?? null;
  const mpPairsData= bot?.mpPairs ?? [];

  /* ── sparkline ── */
  const history: { time: number; balance: number }[] = bot?.balanceHistory ?? [];
  const sparkPoints = useMemo(() => history.map((h) => ({
    balance: h.balance,
    t: new Date(h.time).toLocaleTimeString("es", { hour:"2-digit", minute:"2-digit" }),
  })), [history]);
  const sparkColor  = delta >= 0 ? TEAL : ROSE;
  const sparkMin    = sparkPoints.length > 1 ? Math.min(...sparkPoints.map(p => p.balance)) : null;
  const sparkMax    = sparkPoints.length > 1 ? Math.max(...sparkPoints.map(p => p.balance)) : null;
  const sparkRange  = sparkMin !== null && sparkMax !== null && sparkMax > sparkMin;

  /* ── handlers ── */
  const handleToggle = async () => {
    setToggling(true);
    try {
      const r = await fetch(`${BASE_URL}api/bot/toggle`, {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ active: !isRunning, capitalPercent: capitalPct, liveMode: wantLive }),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "Error desconocido");
        setFlashMsg(`Error: ${errText}`);
        setTimeout(() => setFlashMsg(null), 3000);
        return;
      }
      const d = await r.json();
      await refresh();
      setFlashMsg(d?.active ? "Motor híbrido iniciado" : "Motor detenido");
      setTimeout(() => setFlashMsg(null), 1800);
    } catch (e: any) {
      setFlashMsg(`Error de conexión: ${e?.message ?? "reintentar"}`);
      setTimeout(() => setFlashMsg(null), 3000);
    } finally { setToggling(false); }
  };

  const handleClosePos = async (symbol: string) => {
    setClosingPos(symbol);
    try {
      const r = await fetch(`${BASE_URL}api/bot/close/${symbol}`, { method:"POST" });
      if (r.ok) { await r.json(); refresh(); }
    } catch {} finally { setClosingPos(null); }
  };

  const handleCloseBybit = async (symbol: string) => {
    setClosingBybit(symbol);
    try {
      const r = await fetch(`${BASE_URL}api/bot/close-bybit/${symbol}`, { method:"POST" });
      if (r.ok) { setBybitPositions(prev => prev.filter(p => p.symbol !== symbol)); refresh(); }
    } catch {} finally { setClosingBybit(null); }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const r = await fetch(`${BASE_URL}api/bot/reset`, { method:"POST" });
      if (r.ok) { await r.json(); refresh(); }
    } catch {} finally { setResetting(false); setShowReset(false); }
  };

  const saveCapital = async (pct: number) => {
    setCapitalPct(pct);
    try {
      await fetch(`${BASE_URL}api/bot/settings`, {
        method:"PATCH", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ capitalPercent: pct }),
      });
      refresh();
    } catch {}
  };

  return (
    <Layout>
      <div style={{ maxWidth:480, width:"100%", margin:"0 auto", display:"flex", flexDirection:"column", gap:12, overflowX:"hidden", boxSizing:"border-box" }}>

        {/* ═══════════════════════════════════════
            HERO CARD — CINEMATIC GLASS
        ═══════════════════════════════════════ */}
        <div className="m2m-enter-2" style={{
          position:"relative",
          borderRadius:8,
          overflow:"hidden",
          background:"#0d1421",
          border:`1px solid rgba(255,255,255,0.07)`,
        }}>

          <div style={{ padding:"24px 24px 0" }}>
            {/* label row */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
              <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, letterSpacing:"0.28em", textTransform:"uppercase", color:"rgba(0,229,204,0.55)", fontWeight:600 }}>
                {liveMode ? "BYBIT · MAINNET · UID 555753345" : "EQUITY CURVE · PAPER"}
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                {/* Botón refresh balance */}
                <button
                  onClick={syncBalance}
                  disabled={syncingBal}
                  title="Sincronizar balance con Bybit"
                  style={{
                    width:24, height:24, borderRadius:7,
                    border:"0.5px solid rgba(0,229,204,0.18)",
                    background: syncingBal ? "rgba(0,229,204,0.08)" : "rgba(255,255,255,0.03)",
                    color: syncingBal ? TEAL : "rgba(0,229,204,0.45)",
                    cursor: syncingBal ? "default" : "pointer",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:12, transition:"all 0.2s",
                    animation: syncingBal ? "tanit-ring-out 1s linear infinite" : "none",
                  }}>
                  ↻
                </button>
                {!isRunning && (
                  <button onClick={() => setShowReset(true)} style={{
                    fontFamily:"var(--app-font-mono)", fontSize:8, letterSpacing:"0.15em",
                    color:"rgba(255,255,255,0.2)", background:"rgba(255,255,255,0.03)",
                    border:"0.5px solid rgba(0,229,204,0.08)", borderRadius:6, padding:"3px 10px", cursor:"pointer",
                  }}>RESET</button>
                )}
              </div>
            </div>

            {/* balance + delta */}
            <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", marginBottom:6 }}>
              <div>
                <div className="num-animate" style={{
                  fontFamily:"var(--app-font-sans)", fontWeight:900,
                  fontSize:52, letterSpacing:"-3.5px", color:WHITE, lineHeight:1,
                }}>
                  ${balance.toLocaleString("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 })}
                </div>
              </div>
              <div style={{ textAlign:"right", paddingBottom:6 }}>
                <div style={{
                  fontFamily:"var(--app-font-mono)", fontWeight:800, fontSize:18,
                  color: delta >= 0 ? TEAL : RED,
                }}>
                  {delta >= 0 ? "+" : ""}{delta.toFixed(2)}
                </div>
                <div style={{
                  fontFamily:"var(--app-font-mono)", fontSize:12,
                  color: delta >= 0 ? TEAL : RED, opacity:0.7, marginTop:2,
                }}>
                  {deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(2)}%
                </div>
              </div>
            </div>

            {/* sub-stats */}
            {(sessionPnl !== 0 || totalFees > 0 || positions.length > 0) && (
              <div style={{ display:"flex", gap:0, marginBottom:16, paddingBottom:14, borderBottom:`1px solid rgba(255,255,255,0.05)` }}>
                {sessionPnl !== 0 && (
                  <div style={{ flex:1 }}>
                    <Label color="rgba(255,255,255,0.25)">Sesión PnL</Label>
                    <div style={{ fontFamily:"var(--app-font-mono)", fontSize:13, fontWeight:700, color: sessionPnl >= 0 ? TEAL : ROSE, marginTop:3 }}>
                      {sessionPnl >= 0 ? "+" : ""}{sessionPnl.toFixed(2)}
                    </div>
                  </div>
                )}
                {totalFees > 0 && (
                  <div style={{ flex:1, borderLeft:"1px solid rgba(255,255,255,0.05)", paddingLeft:16 }}>
                    <Label color="rgba(255,255,255,0.25)">Fees</Label>
                    <div style={{ fontFamily:"var(--app-font-mono)", fontSize:13, fontWeight:700, color:ROSE, marginTop:3 }}>
                      -{totalFees.toFixed(2)}
                    </div>
                  </div>
                )}
                {positions.length > 0 && (
                  <div style={{ flex:1, borderLeft:"1px solid rgba(255,255,255,0.05)", paddingLeft:16 }}>
                    <Label color="rgba(255,255,255,0.25)">Unrealized</Label>
                    <div style={{ fontFamily:"var(--app-font-mono)", fontSize:13, fontWeight:700, color: totalUnreal >= 0 ? TEAL : ROSE, marginTop:3 }}>
                      {totalUnreal >= 0 ? "+" : ""}{totalUnreal.toFixed(2)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── EMBEDDED SPARKLINE ── */}
          <div style={{ height:110, position:"relative" }}>
            {sparkPoints.length > 1 ? (
              <>
                {/* gradient overlay over chart edges */}
                <div style={{
                  position:"absolute", inset:0, zIndex:2, pointerEvents:"none",
                  background:"linear-gradient(90deg, rgba(4,6,14,0.6) 0%, transparent 10%, transparent 90%, rgba(4,6,14,0.6) 100%)",
                }} />
                <ResponsiveContainer width="100%" height={110}>
                  <AreaChart data={sparkPoints} margin={{ top:5, right:0, left:0, bottom:0 }}>
                    <defs>
                      <linearGradient id="heroFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor={sparkColor} stopOpacity={0.45} />
                        <stop offset="60%"  stopColor={sparkColor} stopOpacity={0.10} />
                        <stop offset="100%" stopColor={sparkColor} stopOpacity={0.00} />
                      </linearGradient>
                    </defs>
                    <Tooltip content={<SparkTip />} />
                    <Area
                      type="monotone" dataKey="balance"
                      stroke={sparkColor} strokeWidth={2.5}
                      fill="url(#heroFill)" dot={false}
                      activeDot={{ r:4, fill:sparkColor, stroke:"rgba(255,255,255,0.2)", strokeWidth:2 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
                {/* hi/lo labels */}
                {sparkRange && (
                  <div style={{
                    position:"absolute", bottom:4, left:14, right:14, zIndex:3,
                    display:"flex", justifyContent:"space-between",
                    fontFamily:"var(--app-font-mono)", fontSize:8, color:"rgba(255,255,255,0.25)", letterSpacing:"0.04em",
                  }}>
                    <span>L ${sparkMin!.toFixed(2)}</span>
                    <span>H ${sparkMax!.toFixed(2)}</span>
                  </div>
                )}
              </>
            ) : (
              <div style={{
                height:"100%", display:"flex", flexDirection:"column",
                alignItems:"center", justifyContent:"center", gap:4,
              }}>
                {/* flat teal line placeholder */}
                <div style={{ width:"80%", height:1, background:`linear-gradient(90deg, transparent, ${TEAL}55, transparent)` }} />
                <span style={{ fontFamily:"var(--app-font-mono)", fontSize:8, color:"rgba(255,255,255,0.18)", letterSpacing:"0.12em" }}>
                  ACUMULANDO HISTORIAL…
                </span>
              </div>
            )}
          </div>

        </div>{/* END HERO */}

        {/* ═══════════════════════════════════════
            HYBRID ENGINE / BOT CONTROL
        ═══════════════════════════════════════ */}
        <div className="premium-card m2m-enter-3" style={{
          borderRadius:8, overflow:"hidden",
          background:"#0d1421",
          border:`1px solid ${isRunning ? "rgba(14,203,129,0.25)" : "rgba(255,255,255,0.07)"}`,
        }}>
          {/* REGIME indicator */}
          {isRunning && hybrid && (
            <div style={{
              display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"10px 18px", borderBottom:"0.5px solid rgba(0,229,204,0.08)",
              background:regimeInfo.bg,
            }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ width:7, height:7, borderRadius:"50%", background:regimeInfo.color, boxShadow:`0 0 8px ${regimeInfo.color}` }} />
                <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, fontWeight:700, letterSpacing:"0.15em", color:regimeInfo.color }}>
                  {regimeInfo.label}
                </span>
                <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:DIM }}>{hybrid.regimeConfidence}%</span>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                {hybrid.escaleraDriving && (
                  <span style={{ fontFamily:"var(--app-font-mono)", fontSize:8, padding:"2px 6px", borderRadius:4, background:"rgba(0,229,204,0.10)", color:TEAL, border:"1px solid rgba(0,229,204,0.2)" }}>ESC</span>
                )}
                {hybrid.mpDriving && (
                  <span style={{ fontFamily:"var(--app-font-mono)", fontSize:8, padding:"2px 6px", borderRadius:4, background:"rgba(112,144,255,0.10)", color:"#7090ff", border:"1px solid rgba(112,144,255,0.2)" }}>MP</span>
                )}
                {scanAgo !== null && (
                  <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:DIM }}>scan {scanAgo}s</span>
                )}
              </div>
            </div>
          )}

          {/* TOGGLE BUTTON */}
          <button onClick={handleToggle} disabled={toggling}
            data-testid="btn-toggle-bot-simple" className="card-press"
            style={{
              width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"18px 22px", background:"transparent",
              borderBottom:"0.5px solid rgba(0,229,204,0.08)",
              cursor: toggling ? "not-allowed" : "pointer", opacity: toggling ? 0.6 : 1,
            }}>
            <div style={{ textAlign:"left" }}>
              <div style={{ fontFamily:"var(--app-font-sans)", fontWeight:700, fontSize:16, color:WHITE, marginBottom:4, letterSpacing:"-0.3px" }}>
                {isRunning ? "Motor Híbrido" : "Hybrid Engine"}
              </div>
              <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9.5, color:"rgba(255,255,255,0.22)", letterSpacing:"0.04em" }}>
                {isRunning
                  ? `Escalera ${hybrid?.escaleraDriving ? "ON" : "OFF"} · MP ${hybrid?.mpDriving ? "ON" : "OFF"} · scan #${hybrid?.scanCount ?? 0}`
                  : `Capital ${capitalPct}% · AI régimen · 15x/25x/35x`}
              </div>
            </div>
            <div className={toggling ? "" : isRunning ? "m2m-btn-stop" : "m2m-btn-gradient"} style={{
              display:"flex", alignItems:"center", gap:8, padding:"12px 22px", borderRadius:14,
              fontWeight:800, fontSize:13, letterSpacing:"0.1em", fontFamily:"var(--app-font-mono)",
              color: toggling ? TEAL : isRunning ? ROSE : "#fff",
              border: toggling ? `1.5px solid rgba(0,229,204,0.3)` : isRunning ? undefined : "none",
              background: toggling ? "rgba(0,229,204,0.05)" : undefined,
              animation: toggling ? "pulse-toggling 0.5s ease-in-out infinite" : undefined,
              transition:"all 0.3s ease",
              boxShadow: !toggling && !isRunning ? "0 0 20px rgba(0,229,204,0.25), 0 0 60px rgba(0,188,212,0.10)" : undefined,
            }}>
              {toggling ? "..." : isRunning ? "⛔ STOP" : "▶ M2M"}
            </div>
          </button>

          {flashMsg && (
            <div style={{ padding:"8px 14px", fontFamily:"var(--app-font-mono)", fontSize:10, color:TEAL, textAlign:"center" }}>
              {flashMsg}
            </div>
          )}

          {/* CAPITAL SELECTOR */}
          <div style={{ borderTop:`1px solid rgba(255,255,255,0.05)`, padding:"14px 18px 16px" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
              <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, fontWeight:600, color:"rgba(255,255,255,0.28)", letterSpacing:"0.18em" }}>CAPITAL EN RIESGO</span>
              <span style={{
                fontFamily:"var(--app-font-mono)", fontWeight:800, fontSize:15,
                color: capitalPct <= 50 ? TEAL : AMBER,
              }}>
                {capitalPct}%
              </span>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:6 }}>
              {CAPITAL_STEPS.map(s => {
                const sel = capitalPct === s;
                const c = s <= 50 ? TEAL : AMBER;
                return (
                  <button key={s} onClick={() => saveCapital(s)} style={{
                    padding:"11px 0", borderRadius:10,
                    fontFamily:"var(--app-font-mono)", fontWeight:700, fontSize:12,
                    background: sel ? `rgba(${s<=50?"0,229,204":"245,166,35"},0.10)` : "rgba(255,255,255,0.03)",
                    color: sel ? c : "rgba(255,255,255,0.22)",
                    border:`1px solid ${sel ? c+"44" : "rgba(255,255,255,0.06)"}`,
                    cursor:"pointer", transition:"all 0.15s",
                  }}>{s}%</button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ═══════════════════════════════════════
            HUNTING
        ═══════════════════════════════════════ */}
        {isRunning && positions.length === 0 && mpPairsData.length === 0 && (
          <div style={{
            display:"flex", alignItems:"center", gap:10,
            padding:"12px 16px", borderRadius:6,
            background:"rgba(14,203,129,0.05)",
            border:`1px solid rgba(14,203,129,0.18)`,
          }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:TEAL, animation:"pulse-dot 1.2s ease-in-out infinite" }} />
            <span style={{ fontFamily:"var(--app-font-mono)", fontSize:10, fontWeight:700, letterSpacing:"0.15em", color:TEAL }}>CAZANDO</span>
            <span style={{ fontFamily:"var(--app-font-mono)", fontSize:10, color:DIM }}>
              {scanAgo !== null ? `scan hace ${scanAgo}s` : "buscando señales..."}
            </span>
          </div>
        )}

        {/* ═══════════════════════════════════════
            BYBIT REAL POSITIONS — BYBIT STYLE
        ═══════════════════════════════════════ */}
        {bybitPositions.length > 0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:2 }}>

            {/* section header */}
            <div style={{
              display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"10px 14px 9px",
              background:"rgba(245,166,35,0.05)",
              border:"1px solid rgba(245,166,35,0.18)",
              borderBottom:"none",
              borderRadius:"6px 6px 0 0",
            }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ width:7, height:7, borderRadius:"50%", background:AMBER, boxShadow:`0 0 8px ${AMBER}80`, animation:"pulse-dot 1.5s ease-in-out infinite" }} />
                <span style={{ fontSize:9, fontWeight:800, color:AMBER, letterSpacing:"0.18em", fontFamily:"var(--app-font-mono)" }}>
                  POSICIONES BYBIT EN VIVO
                </span>
              </div>
              <span style={{
                fontSize:9, fontWeight:700, color:"rgba(245,166,35,0.8)",
                background:"rgba(245,166,35,0.10)", border:"1px solid rgba(245,166,35,0.20)",
                borderRadius:100, padding:"2px 8px", fontFamily:"var(--app-font-mono)",
              }}>{bybitPositions.length} OPEN</span>
            </div>

            {/* column headers — bybit style */}
            <div style={{
              display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr auto",
              padding:"7px 14px",
              background:"rgba(10,14,22,0.98)",
              border:"1px solid rgba(242,54,69,0.15)",
              borderTop:"none", borderBottom:"none",
            }}>
              {["CONTRATO","ENTRADA","MARK","SIZE","PnL"].map((h,i) => (
                <div key={h} style={{
                  fontFamily:"var(--app-font-mono)", fontSize:8, fontWeight:700,
                  color:"rgba(255,255,255,0.22)", letterSpacing:"0.12em",
                  textAlign: i >= 3 ? "right" : "left",
                }}>{h}</div>
              ))}
            </div>

            {bybitPositions.map((p: any, idx: number) => {
              const ticker    = p.symbol?.replace("USDT","") ?? p.symbol;
              const isLong    = p.side === "Buy";
              const pnl       = parseFloat(p.unrealisedPnl ?? p.unrealizedPnl ?? "0");
              const entryPrice= parseFloat(p.avgPrice ?? p.entryPrice ?? "0");
              const markPrice = parseFloat(p.markPrice ?? "0");
              const lev       = parseInt(p.leverage ?? "5") || 5;
              const size      = parseFloat(p.size ?? "0");
              const closing   = closingBybit === p.symbol;
              const pct       = entryPrice > 0 ? ((markPrice - entryPrice) / entryPrice * 100 * (isLong ? 1 : -1)).toFixed(2) : "0.00";
              const isLast    = idx === bybitPositions.length - 1;

              // Leverage visual system
              const LEV_MAX   = 75;
              const levPct    = Math.min(100, Math.round(((lev - 5) / (LEV_MAX - 5)) * 100));
              const isHarvest = lev >= LEV_MAX;
              const levColor  = lev >= 70 ? "#FFD700"
                              : lev >= 50 ? "#00E5CC"
                              : lev >= 30 ? "#f97316"
                              : lev >= 16 ? "#f59e0b"
                              : "rgba(148,163,184,0.5)";
              const levGlow   = lev >= 70 ? "0 0 12px rgba(255,215,0,0.4)"
                              : lev >= 50 ? "0 0 10px rgba(0,229,204,0.35)"
                              : lev >= 30 ? "0 0 8px rgba(249,115,22,0.3)"
                              : "none";
              const cardBorder= isHarvest ? "rgba(255,215,0,0.4)"
                              : lev >= 50 ? "rgba(0,229,204,0.3)"
                              : pnl >= 0 ? "rgba(14,203,129,0.15)" : "rgba(246,70,93,0.15)";
              const cardBg    = isHarvest ? "rgba(255,215,0,0.04)"
                              : lev >= 50 ? "rgba(0,229,204,0.03)"
                              : pnl >= 0 ? "rgba(14,203,129,0.03)" : "rgba(246,70,93,0.03)";

              return (
                <div key={`${p.symbol}_${p.side ?? idx}`} style={{
                  background: cardBg,
                  border:`1px solid ${cardBorder}`,
                  borderTop:"none",
                  borderRadius: isLast ? "0 0 8px 8px" : 0,
                  padding:"13px 14px 11px",
                  boxShadow: lev >= 50 ? levGlow : "none",
                  transition:"box-shadow 0.3s",
                }}>
                  {/* TOP ROW — symbol + leverage badge + pnl */}
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                    {/* Left: ticker + direction */}
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontFamily:"var(--app-font-sans)", fontWeight:900, fontSize:16, color:WHITE, letterSpacing:"-0.02em" }}>{ticker}</span>
                      <span style={{
                        fontFamily:"var(--app-font-mono)", fontSize:9, fontWeight:800, letterSpacing:"0.06em",
                        padding:"2px 6px", borderRadius:4,
                        background: isLong ? "rgba(0,229,204,0.12)" : "rgba(242,54,69,0.12)",
                        color: isLong ? TEAL : ROSE,
                        border:`1px solid ${isLong ? "rgba(0,229,204,0.3)" : "rgba(242,54,69,0.3)"}`,
                      }}>{isLong ? "LONG" : "SHORT"}</span>
                      {isHarvest && (
                        <span style={{
                          fontFamily:"var(--app-font-mono)", fontSize:8, fontWeight:800, letterSpacing:"0.08em",
                          padding:"2px 5px", borderRadius:4,
                          background:"rgba(255,215,0,0.15)", color:"#FFD700",
                          border:"1px solid rgba(255,215,0,0.4)",
                          animation:"pulse 1.5s ease-in-out infinite",
                        }}>🌾 HARVEST</span>
                      )}
                    </div>
                    {/* Right: PnL */}
                    <div style={{ textAlign:"right" }}>
                      <div style={{
                        fontFamily:"var(--app-font-mono)", fontSize:18, fontWeight:900, lineHeight:1,
                        color: pnl >= 0 ? TEAL : RED,
                        textShadow: pnl >= 0 ? "0 0 8px rgba(0,229,204,0.4)" : "0 0 8px rgba(242,54,69,0.3)",
                      }}>
                        {pnl >= 0 ? "+" : ""}{pnl.toFixed(3)}
                      </div>
                      <div style={{ fontFamily:"var(--app-font-mono)", fontSize:8, color:"rgba(255,255,255,0.25)", marginTop:1 }}>USDT</div>
                    </div>
                  </div>

                  {/* MIDDLE ROW — price data + leverage badge */}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr auto", alignItems:"center", gap:6, marginBottom:10 }}>
                    <div>
                      <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:DIM, letterSpacing:"0.08em", marginBottom:2 }}>ENTRADA</div>
                      <div style={{ fontFamily:"var(--app-font-mono)", fontSize:12, fontWeight:600, color:SOFT }}>${entryPrice.toFixed(entryPrice < 10 ? 4 : 2)}</div>
                    </div>
                    <div>
                      <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:DIM, letterSpacing:"0.08em", marginBottom:2 }}>MARK</div>
                      <div style={{ fontFamily:"var(--app-font-mono)", fontSize:12, fontWeight:700, color: pnl >= 0 ? TEAL : ROSE }}>${markPrice.toFixed(markPrice < 10 ? 4 : 2)}</div>
                      <div style={{ fontFamily:"var(--app-font-mono)", fontSize:8, color: pnl >= 0 ? "rgba(0,229,204,0.55)" : "rgba(242,54,69,0.55)" }}>
                        {pnl >= 0 ? "▲" : "▼"} {Math.abs(parseFloat(pct))}%
                      </div>
                    </div>
                    <div>
                      <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:DIM, letterSpacing:"0.08em", marginBottom:2 }}>SIZE</div>
                      <div style={{ fontFamily:"var(--app-font-mono)", fontSize:12, color:MID }}>{size}</div>
                    </div>
                    {/* LEVERAGE BADGE — the star */}
                    <div style={{ textAlign:"center" }}>
                      <div style={{
                        fontFamily:"var(--app-font-mono)", fontSize:22, fontWeight:900, lineHeight:1,
                        color: levColor,
                        textShadow: levGlow,
                        letterSpacing:"-0.03em",
                      }}>{lev}x</div>
                      <div style={{ fontFamily:"var(--app-font-mono)", fontSize:7, color:"rgba(255,255,255,0.3)", marginTop:1, letterSpacing:"0.06em" }}>
                        {lev >= 70 ? "MÁXIMO" : lev >= 50 ? "ALTO" : lev >= 30 ? "MEDIO" : lev >= 16 ? "SUBIENDO" : "ENTRADA"}
                      </div>
                    </div>
                  </div>

                  {/* LEVERAGE PROGRESS BAR */}
                  <div style={{ marginBottom:10 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                      <span style={{ fontFamily:"var(--app-font-mono)", fontSize:7, color:"rgba(255,255,255,0.2)", letterSpacing:"0.08em" }}>5x</span>
                      <span style={{ fontFamily:"var(--app-font-mono)", fontSize:7, color:"rgba(255,255,255,0.2)", letterSpacing:"0.08em" }}>TANIT LEVER · {levPct}%</span>
                      <span style={{ fontFamily:"var(--app-font-mono)", fontSize:7, color:levColor, letterSpacing:"0.08em" }}>75x</span>
                    </div>
                    <div style={{ height:3, borderRadius:99, background:"rgba(255,255,255,0.06)", overflow:"hidden" }}>
                      <div style={{
                        height:"100%", borderRadius:99,
                        width:`${levPct}%`,
                        background: lev >= 70 ? "linear-gradient(90deg,#f97316,#FFD700)"
                                  : lev >= 50 ? "linear-gradient(90deg,#f59e0b,#00E5CC)"
                                  : lev >= 30 ? "linear-gradient(90deg,#94a3b8,#f97316)"
                                  : "linear-gradient(90deg,#94a3b8,#f59e0b)",
                        boxShadow: lev >= 50 ? levGlow : "none",
                        transition:"width 0.5s ease",
                      }} />
                    </div>
                  </div>

                  {/* close button */}
                  <button
                    onClick={() => handleCloseBybit(p.symbol)}
                    disabled={closing}
                    style={{
                      width:"100%", padding:"9px 0", borderRadius:8,
                      fontFamily:"var(--app-font-mono)", fontWeight:700, fontSize:11, letterSpacing:"0.08em",
                      background: closing ? "rgba(242,54,69,0.05)" : "rgba(242,54,69,0.09)",
                      border:`1px solid ${closing ? "rgba(242,54,69,0.15)" : "rgba(242,54,69,0.30)"}`,
                      color: ROSE, cursor: closing ? "not-allowed" : "pointer", transition:"all 0.15s",
                    }}
                  >
                    {closing ? "Cerrando al mercado…" : `⬛ Cerrar ${ticker} — Market`}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* ═══════════════════════════════════════
            ENGINE POSITIONS
        ═══════════════════════════════════════ */}
        {positions.length > 0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {positions.map((pos: any, posIdx: number) => {
              const isLong   = pos.side === "LONG";
              const pnlColor = (pos.unrealizedPnl ?? 0) >= 0 ? TEAL : ROSE;
              const accent   = isLong ? TEAL : ROSE;
              const cur      = prices[pos.symbol] ? Number(prices[pos.symbol]) : pos.entryPrice;
              const distSL   = pos.stopLoss ? Math.abs(cur - pos.stopLoss) / cur * 100 : null;
              const distTP   = pos.takeProfit ? Math.abs(pos.takeProfit - cur) / cur * 100 : null;
              const held     = pos.openedAt ? Math.round((now - new Date(pos.openedAt).getTime()) / 60000) : 0;
              const coin     = SYM[pos.symbol] ?? pos.symbol?.replace("USDT","");
              return (
                <div key={`${pos.symbol}_${posIdx}`} style={{
                  borderRadius:8, padding:"16px 18px", overflow:"hidden",
                  background: (pos.unrealizedPnl ?? 0) >= 0 ? "rgba(14,203,129,0.04)" : "rgba(246,70,93,0.04)",
                  border:`1px solid ${(pos.unrealizedPnl ?? 0) >= 0 ? "rgba(14,203,129,0.18)" : "rgba(246,70,93,0.18)"}`,
                }}>

                  {/* header row */}
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{
                        fontFamily:"var(--app-font-mono)", fontWeight:800, fontSize:8, letterSpacing:"0.1em",
                        padding:"3px 8px", borderRadius:5,
                        background: isLong ? TEAL : ROSE,
                        color: isLong ? "#020d09" : WHITE,
                      }}>{pos.side}</span>
                      <span style={{ fontFamily:"var(--app-font-sans)", fontWeight:700, fontSize:18, color:WHITE }}>{coin}</span>
                      <span style={{ fontFamily:"var(--app-font-mono)", fontSize:11, color:MID }}>{pos.leverage}x</span>
                      <span style={{ fontFamily:"var(--app-font-mono)", fontSize:10, color:DIM }}>{held}m</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <div style={{ textAlign:"right" }}>
                        <div style={{ fontFamily:"var(--app-font-mono)", fontWeight:800, fontSize:20, color:pnlColor }}>
                          {(pos.unrealizedPnl ?? 0) >= 0 ? "+" : ""}{(pos.unrealizedPnl ?? 0).toFixed(2)}
                        </div>
                      </div>
                      <button
                        onClick={() => handleClosePos(pos.symbol)}
                        disabled={closingPos === pos.symbol}
                        style={{
                          fontFamily:"var(--app-font-mono)", fontWeight:700, fontSize:9, letterSpacing:"0.10em",
                          padding:"6px 12px", borderRadius:8,
                          background:BG_LOSS, color:ROSE,
                          border:`1px solid ${BDR_LSS}`,
                          cursor: closingPos === pos.symbol ? "not-allowed" : "pointer",
                          opacity: closingPos === pos.symbol ? 0.5 : 1,
                        }}>
                        {closingPos === pos.symbol ? "..." : "CERRAR"}
                      </button>
                    </div>
                  </div>

                  <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6 }}>
                    {([
                      ["Entrada",  px(pos.entryPrice), SOFT],
                      ["Actual",   px(cur),            accent],
                      [`SL ${distSL !== null ? distSL.toFixed(1)+"%" : ""}`, px(pos.stopLoss), ROSE],
                      [`TP ${distTP !== null ? distTP.toFixed(1)+"%" : ""}`, px(pos.takeProfit), TEAL],
                    ] as [string,string,string][]).map(([lbl,val,c]) => (
                      <div key={lbl} style={{ background:DEEP, borderRadius:8, padding:"8px 4px", textAlign:"center" }}>
                        <Label color={DIM}>{lbl}</Label>
                        <div style={{ fontFamily:"var(--app-font-mono)", fontWeight:700, fontSize:10, color:c, marginTop:4 }}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ═══════════════════════════════════════
            MP PAIRS
        ═══════════════════════════════════════ */}
        {mpPairsData.length > 0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <div style={{
              display:"flex", alignItems:"center", gap:8,
              padding:"10px 16px", borderRadius:10,
              background:"rgba(112,144,255,0.06)", border:"1px solid rgba(112,144,255,0.15)",
            }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:"#7090ff" }} />
              <span style={{ fontFamily:"var(--app-font-mono)", fontSize:10, fontWeight:700, letterSpacing:"0.15em", color:"#7090ff" }}>
                MIDDLE POINT · {mpPairsData.length} par{mpPairsData.length > 1 ? "es" : ""}
              </span>
            </div>
            {mpPairsData.map((pair: any) => {
              const coin      = SYM[pair.symbol] ?? pair.symbol?.replace("USDT","");
              const netU      = pair.unrealizedPnl ?? 0;
              const bothClosed= pair.longClosed && pair.shortClosed;
              return (
                <div key={pair.symbol} style={{
                  padding:"14px 16px", borderRadius:8,
                  background: "#0d1421",
                  border:`1px solid ${bothClosed ? "rgba(14,203,129,0.20)" : "rgba(112,144,255,0.18)"}`,
                  borderLeft:`3px solid ${bothClosed ? TEAL : "#7090ff"}`,
                }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ fontFamily:"var(--app-font-sans)", fontWeight:700, fontSize:18, color:WHITE }}>{coin}</span>
                      <span style={{ fontFamily:"var(--app-font-mono)", fontSize:10, color:"#7090ff" }}>{pair.leverage}x</span>
                      {!bothClosed && pair.dualSide !== false && (
                        <span style={{ fontFamily:"var(--app-font-mono)", fontSize:8, color:"#e0c840", background:"#1a1600", border:"1px solid #3a3000", borderRadius:4, padding:"2px 5px" }}>
                          {!pair.longClosed && !pair.shortClosed ? "DUAL ↕" : pair.longClosed ? "SHORT▾" : "LONG▴"}
                        </span>
                      )}
                      {bothClosed && (
                        <span style={{ fontFamily:"var(--app-font-mono)", fontSize:8, color:TEAL, background:"#051810", border:"1px solid #0d3020", borderRadius:4, padding:"2px 5px" }}>CERRADO</span>
                      )}
                    </div>
                    <div style={{ fontFamily:"var(--app-font-mono)", fontWeight:800, fontSize:18, color: netU >= 0 ? TEAL : ROSE }}>
                      {netU >= 0 ? "+" : ""}{netU.toFixed(2)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ═══════════════════════════════════════
            ESCALERA LAYERS
        ═══════════════════════════════════════ */}
        {isRunning && escalera && Array.isArray(escalera.instances) && escalera.instances.filter((inst: any) => inst.openLayerCount > 0).length > 0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {escalera.instances.filter((inst: any) => inst.openLayerCount > 0).map((inst: any) => (
              <div key={inst.symbol} style={{ padding:"10px 14px", borderRadius:12, background:"rgba(0,229,204,0.04)", border:"0.5px solid rgba(0,229,204,0.10)" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                  <span style={{ fontFamily:"var(--app-font-mono)", fontWeight:800, fontSize:11, color:TEAL }}>
                    {inst.symbol.replace("USDT","")}
                  </span>
                  <span style={{
                    fontFamily:"var(--app-font-mono)", fontSize:9,
                    color: inst.direction === "LONG" ? TEAL : inst.direction === "SHORT" ? ROSE : MID,
                    background: inst.direction === "LONG" ? "rgba(0,229,204,0.10)" : "rgba(242,54,69,0.10)",
                    padding:"1px 5px", borderRadius:4,
                  }}>{inst.direction ?? "—"}</span>
                  <span style={{ fontFamily:"var(--app-font-mono)", fontSize:10, fontWeight:700, color:(inst.totalNetPnl ?? 0) >= 0 ? "#00ff88" : ROSE }}>
                    {(inst.totalNetPnl ?? 0) >= 0 ? "+" : ""}{(inst.totalNetPnl ?? 0).toFixed(4)}
                  </span>
                  <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:DIM }}>{inst.openLayerCount} cap.</span>
                </div>
                <div style={{ display:"flex", gap:3 }}>
                  {(inst.layers ?? []).map((l: any) => (
                    <div key={l.leverageX} style={{
                      flex:1, height:3, borderRadius:2,
                      background: l.status === "secured" ? "#00ff88" : l.status === "breakeven" ? TEAL : l.status === "open" ? AMBER : "rgba(255,255,255,0.06)",
                    }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ═══════════════════════════════════════
            OPEN INTEREST
        ═══════════════════════════════════════ */}
        {oiData && oiData.symbols.length > 0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
            <div style={{
              display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"9px 14px",
              background:"rgba(8,14,24,0.98)",
              border:"1px solid rgba(112,144,255,0.14)",
              borderBottom:"none",
              borderRadius:"10px 10px 0 0",
            }}>
              <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                <div style={{ width:5, height:5, borderRadius:"50%", background:"#7090ff", opacity:0.85 }} />
                <span style={{ fontFamily:"var(--app-font-mono)", fontSize:8, fontWeight:700, color:"rgba(112,144,255,0.70)", letterSpacing:"0.18em" }}>
                  OPEN INTEREST · Δ4h
                </span>
              </div>
              {oiData.demo && (
                <span style={{ fontFamily:"var(--app-font-mono)", fontSize:7, color:"rgba(255,255,255,0.18)", letterSpacing:"0.10em" }}>DEMO</span>
              )}
            </div>
            <div style={{
              display:"grid",
              gridTemplateColumns:"repeat(4, 1fr)",
              background:"rgba(6,10,18,0.96)",
              border:"1px solid rgba(112,144,255,0.14)",
              borderTop:"none",
              borderRadius:"0 0 10px 10px",
              overflow:"hidden",
            }}>
              {oiData.symbols.slice(0, 8).map((item: OISummaryItem, idx: number) => {
                const isUp   = item.arrow === "up";
                const isDn   = item.arrow === "down";
                const dColor = isUp ? TEAL : isDn ? ROSE : MID;
                const dArrow = isUp ? "▲" : isDn ? "▼" : "→";
                const borderRight = (idx % 4 !== 3) ? "1px solid rgba(255,255,255,0.04)" : "none";
                const borderBottom= idx < 4 ? "1px solid rgba(255,255,255,0.04)" : "none";
                return (
                  <div key={item.symbol} style={{
                    padding:"10px 10px 9px",
                    borderRight,
                    borderBottom,
                    display:"flex", flexDirection:"column", gap:3,
                  }}>
                    <div style={{ fontFamily:"var(--app-font-sans)", fontWeight:700, fontSize:11, color:WHITE }}>{item.coin}</div>
                    <div style={{ fontFamily:"var(--app-font-mono)", fontSize:10, fontWeight:600, color:SOFT }}>
                      {fmtOI(item.openInterest)}
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                      <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:dColor, fontWeight:700 }}>{dArrow}</span>
                      <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:dColor }}>
                        {item.delta4h >= 0 ? "+" : ""}{item.delta4h.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════
            STATS BAR
        ═══════════════════════════════════════ */}
        <button onClick={() => navigate("/historial")} className="card-press m2m-enter-4" style={{
          display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"16px 20px", borderRadius:8,
          background:"#0d1421",
          border:"1px solid rgba(255,255,255,0.07)",
          cursor:"pointer", width:"100%",
        }}>
          <div style={{ display:"flex", alignItems:"center", gap:0 }}>
            <div style={{ textAlign:"center", paddingRight:20 }}>
              <div style={{ fontFamily:"var(--app-font-mono)", fontWeight:900, fontSize:26, color:TEAL, lineHeight:1 }}>{wins}</div>
              <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:"rgba(0,229,204,0.45)", letterSpacing:"0.12em", marginTop:4 }}>WINS</div>
            </div>
            <div style={{ width:1, height:36, background:"rgba(255,255,255,0.06)" }} />
            <div style={{ textAlign:"center", padding:"0 20px" }}>
              <div style={{ fontFamily:"var(--app-font-mono)", fontWeight:900, fontSize:26, color:ROSE, lineHeight:1 }}>{losses}</div>
              <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:"rgba(242,54,69,0.45)", letterSpacing:"0.12em", marginTop:4 }}>LOSSES</div>
            </div>
            {(wins + losses) > 0 && (
              <>
                <div style={{ width:1, height:36, background:"rgba(255,255,255,0.06)" }} />
                <div style={{ textAlign:"center", paddingLeft:20 }}>
                  <div style={{ fontFamily:"var(--app-font-mono)", fontWeight:900, fontSize:26, color:WHITE, lineHeight:1 }}>{winRate}%</div>
                  <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:"rgba(255,255,255,0.25)", letterSpacing:"0.12em", marginTop:4 }}>RATE</div>
                </div>
              </>
            )}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:5, background:"rgba(0,229,204,0.07)", border:"1px solid rgba(0,229,204,0.15)", borderRadius:100, padding:"5px 12px" }}>
            <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, letterSpacing:"0.10em", color:"rgba(0,229,204,0.7)" }}>HISTORIAL</span>
            <span style={{ color:TEAL, fontSize:11, lineHeight:1 }}>→</span>
          </div>
        </button>

        {/* ═══════════════════════════════════════
            RECENT TRADES
        ═══════════════════════════════════════ */}
        {tradeLog.length > 0 && (
          <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
            <div style={{
              padding:"8px 14px",
              background:"rgba(8,14,24,0.98)",
              border:"1px solid rgba(255,255,255,0.06)",
              borderBottom:"none",
              borderRadius:"12px 12px 0 0",
            }}>
              <span style={{ fontFamily:"var(--app-font-mono)", fontSize:8, fontWeight:700, color:"rgba(255,255,255,0.20)", letterSpacing:"0.18em" }}>
                ÚLTIMAS OPERACIONES
              </span>
            </div>
            {tradeLog.slice(-5).reverse().map((t: any, i: number, arr: any[]) => {
              const reason = getReason(t.closeReason ?? "");
              const isWin  = t.pnl > 0;
              const isLast = i === arr.length - 1;
              return (
                <div key={i} style={{
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                  padding:"10px 14px",
                  background: isWin ? "rgba(0,229,204,0.025)" : "rgba(242,54,69,0.025)",
                  borderLeft:`2px solid ${isWin ? "rgba(0,229,204,0.25)" : "rgba(242,54,69,0.20)"}`,
                  border:`1px solid ${isWin ? "rgba(0,229,204,0.08)" : "rgba(242,54,69,0.08)"}`,
                  borderTop:"none",
                  borderRadius: isLast ? "0 0 12px 12px" : 0,
                }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <div style={{
                      fontFamily:"var(--app-font-mono)", fontSize:8, fontWeight:800,
                      padding:"2px 6px", borderRadius:4,
                      background:reason.bg, color:reason.text,
                    }}>{reason.label}</div>
                    <span style={{ fontFamily:"var(--app-font-sans)", fontWeight:700, fontSize:13, color:WHITE }}>
                      {(t.symbol ?? "").replace("USDT","")}
                    </span>
                    <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:DIM }}>
                      {t.side === "LONG" ? "L" : "S"} {t.leverage}x
                    </span>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{
                      fontFamily:"var(--app-font-mono)", fontWeight:800, fontSize:14,
                      color: isWin ? TEAL : ROSE,
                    }}>
                      {t.pnl >= 0 ? "+" : ""}{t.pnl.toFixed(2)}
                    </span>
                    <span style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:DIM }}>
                      {t.closedAt ? timeAgo(t.closedAt) : ""}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* spacer */}
        <div style={{ height:20 }} />

      </div>

      {/* ── RESET CONFIRM ── */}
      {showReset && (
        <div style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(0,0,0,0.75)", backdropFilter:"blur(8px)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}
          onClick={() => setShowReset(false)}>
          <div style={{ background:"#081018", border:"1px solid rgba(242,54,69,0.25)", borderRadius:20, padding:"28px 24px", maxWidth:320, width:"100%" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:ROSE, letterSpacing:"0.18em", marginBottom:10 }}>RESET ENGINE</div>
            <div style={{ fontFamily:"var(--app-font-sans)", fontWeight:800, fontSize:18, color:"#fff", marginBottom:8 }}>¿Resetear todo?</div>
            <div style={{ fontFamily:"var(--app-font-mono)", fontSize:10, color:"#8894b0", lineHeight:1.7, marginBottom:24 }}>
              Borras balance simulado, historial y posiciones del engine. Las posiciones reales en Bybit no se tocan.
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <button onClick={() => setShowReset(false)} style={{ padding:"14px", borderRadius:12, fontFamily:"var(--app-font-mono)", fontWeight:700, fontSize:11, letterSpacing:"0.08em", background:"#050c14", color:"#8894b0", border:"1px solid #122030", cursor:"pointer" }}>CANCELAR</button>
              <button onClick={handleReset} disabled={resetting} style={{ padding:"14px", borderRadius:12, fontFamily:"var(--app-font-mono)", fontWeight:700, fontSize:11, letterSpacing:"0.08em", background:resetting ? "#333" : ROSE, color:"#fff", border:"none", cursor:resetting ? "not-allowed" : "pointer", opacity:resetting ? 0.7 : 1 }}>{resetting ? "..." : "SÍ, RESET"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── LIVE MODE CONFIRM ── */}
      {showLive && (
        <div style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(0,0,0,0.8)", backdropFilter:"blur(10px)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}
          onClick={() => setShowLive(false)}>
          <div style={{ background:"#080c14", border:"1px solid rgba(242,54,69,0.30)", borderRadius:22, padding:"30px 26px", maxWidth:340, width:"100%" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily:"var(--app-font-mono)", fontSize:9, color:ROSE, letterSpacing:"0.2em", marginBottom:12 }}>⚠ MODO REAL</div>
            <div style={{ fontFamily:"var(--app-font-sans)", fontWeight:800, fontSize:20, color:"#fff", marginBottom:10 }}>Activar Bybit Mainnet</div>
            <div style={{ fontFamily:"var(--app-font-mono)", fontSize:10, color:"#8894b0", lineHeight:1.8, marginBottom:26 }}>
              El bot operará con dinero real en Bybit. Las pérdidas son reales. Asegúrate de tener capital disponible y SL configurado.
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <button onClick={() => setShowLive(false)} style={{ padding:"15px", borderRadius:13, fontFamily:"var(--app-font-mono)", fontWeight:700, fontSize:11, background:"#050c14", color:"#8894b0", border:"1px solid #122030", cursor:"pointer" }}>CANCELAR</button>
              <button onClick={async () => {
                setShowLive(false); setWantLive(true);
                await fetch(`${BASE_URL}api/bot/settings`, { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ liveMode: true }) }).catch(() => {});
                refresh();
              }} style={{ padding:"15px", borderRadius:13, fontFamily:"var(--app-font-mono)", fontWeight:700, fontSize:11, background:ROSE, color:"#fff", border:"none", cursor:"pointer" }}>
                SÍ, REAL MONEY
              </button>
            </div>
          </div>
        </div>
      )}

    </Layout>
  );
}
