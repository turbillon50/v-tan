import { useEffect, useMemo, useRef, useState } from "react";
import { Layout } from "@/components/layout";
import { BASE_URL } from "@/lib/api";
import { useBotStatus } from "@/contexts/TradingModeContext";

/* ── palette ── */
const TEAL  = "#0ECB81";
const ROSE  = "#F6465D";
const AMBER = "#F5A623";
const DIM   = "#7a8ba8";
const MID   = "#a8b6cc";
const WHITE = "#FFFFFF";
const CARD  = "#0d1421";

const fmt    = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUSD = (n: number, d = 2) => "$" + fmt(n, d);

type Range = "15M" | "1H" | "6H" | "1D" | "7D" | "30D" | "ALL";
const RANGES: { label: Range; ms: number }[] = [
  { label: "15M", ms: 15 * 60 * 1000 },
  { label: "1H",  ms: 60 * 60 * 1000 },
  { label: "6H",  ms: 6 * 60 * 60 * 1000 },
  { label: "1D",  ms: 24 * 60 * 60 * 1000 },
  { label: "7D",  ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30D", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "ALL", ms: Infinity },
];

function Chip({ label, value, color = WHITE, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ background: CARD, border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "12px 14px", minWidth: 0, flex: 1 }}>
      <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, letterSpacing: "0.18em", color: DIM, marginBottom: 5, textTransform: "uppercase" as const }}>{label}</div>
      <div style={{ fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 14, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function timeAgo(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

const REASON_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  "Take Profit": { bg: "rgba(14,203,129,0.15)",  fg: TEAL,      label: "TP"    },
  "Stop Loss":   { bg: "rgba(246,70,93,0.15)",   fg: ROSE,      label: "SL"    },
  "Flip":        { bg: "rgba(245,166,35,0.15)",  fg: AMBER,     label: "FLIP"  },
  "MP Take":     { bg: "rgba(112,144,255,0.15)", fg: "#7090ff", label: "MP·TP" },
  "MP Stop":     { bg: "rgba(246,70,93,0.15)",   fg: ROSE,      label: "MP·SL" },
  "Tiempo":      { bg: "rgba(107,122,153,0.15)", fg: DIM,       label: "TIME"  },
  "Bot detenido":{ bg: "rgba(107,122,153,0.15)", fg: DIM,       label: "STOP"  },
};
function getReasonChip(r: string) {
  const k = Object.keys(REASON_COLORS).find(k => r?.includes(k));
  return k ? REASON_COLORS[k] : { bg: "rgba(255,255,255,0.06)", fg: MID, label: "—" };
}

/* ═══════════════════════════════════════════════════════════
   CUSTOM M2M CHART — no third-party logos, full touch control
═══════════════════════════════════════════════════════════ */
interface ChartPoint { time: number; value: number; } // time in ms
interface ChartView  { xMin: number; xMax: number; }  // time in ms

function formatAxisTime(ms: number, span: number): string {
  const d = new Date(ms);
  if (span < 2 * 60 * 60 * 1000) {
    return d.getUTCHours().toString().padStart(2, "0") + ":" + d.getUTCMinutes().toString().padStart(2, "0");
  }
  if (span < 7 * 24 * 60 * 60 * 1000) {
    return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + d.getUTCHours().toString().padStart(2, "0") + "h";
  }
  return (d.getUTCMonth() + 1) + "/" + d.getUTCDate();
}

function M2MChart({ data, color, height }: { data: ChartPoint[]; color: string; height: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef       = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ChartView | null>(null);
  const [crosshair, setCrosshair] = useState<{ x: number; y: number; value: number; time: number } | null>(null);
  const touchRef = useRef<any>(null);
  const viewRef  = useRef<ChartView | null>(null);

  // Sync ref for touch handlers
  useEffect(() => { viewRef.current = view; }, [view]);

  // Init / reset view when data changes
  useEffect(() => {
    if (data.length < 2) return;
    setView({ xMin: data[0].time, xMax: data[data.length - 1].time });
  }, [data]);

  const W = 400; // SVG coordinate space width
  const H = height;
  const PAD = { top: 14, right: 58, bottom: 28, left: 8 };
  const CW  = W - PAD.left - PAD.right;
  const CH  = H - PAD.top  - PAD.bottom;

  // Visible slice
  const visible = useMemo(() => {
    if (!view || data.length < 2) return data;
    const pts = data.filter(d => d.time >= view.xMin && d.time <= view.xMax);
    const before = data.filter(d => d.time < view.xMin);
    const after  = data.filter(d => d.time > view.xMax);
    if (before.length > 0) pts.unshift(before[before.length - 1]);
    if (after.length  > 0) pts.push(after[0]);
    return pts;
  }, [data, view]);

  const yMin = useMemo(() => visible.length ? Math.min(...visible.map(d => d.value)) : 0, [visible]);
  const yMax = useMemo(() => visible.length ? Math.max(...visible.map(d => d.value)) : 1, [visible]);
  const yPad = Math.max((yMax - yMin) * 0.08, 0.001);

  const xScale = (t: number) => {
    if (!view) return 0;
    return PAD.left + ((t - view.xMin) / (view.xMax - view.xMin)) * CW;
  };
  const yScale = (v: number) => {
    return PAD.top + CH - ((v - (yMin - yPad)) / ((yMax + yPad) - (yMin - yPad))) * CH;
  };

  // SVG paths
  const { linePath, areaPath } = useMemo(() => {
    if (!view || visible.length < 2) return { linePath: "", areaPath: "" };
    const pts = visible.map(d => ({ x: xScale(d.time), y: yScale(d.value) }));
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const first = pts[0], last = pts[pts.length - 1];
    const bottom = H - PAD.bottom;
    const area = `${line} L${last.x.toFixed(1)},${bottom} L${first.x.toFixed(1)},${bottom} Z`;
    return { linePath: line, areaPath: area };
  }, [visible, view]);

  // Y-axis ticks
  const yTicks = useMemo(() => {
    const range = yMax - yMin;
    const step = range < 0.1 ? 0.01 : range < 1 ? 0.1 : range < 10 ? 1 : range < 100 ? 10 : 100;
    const ticks: number[] = [];
    const start = Math.ceil((yMin - yPad) / step) * step;
    for (let v = start; v <= yMax + yPad; v += step) ticks.push(+v.toFixed(6));
    return ticks.slice(0, 6);
  }, [yMin, yMax, yPad]);

  // X-axis ticks
  const xTicks = useMemo(() => {
    if (!view) return [];
    const span = view.xMax - view.xMin;
    const count = 4;
    const step = span / count;
    return Array.from({ length: count + 1 }, (_, i) => view.xMin + i * step);
  }, [view]);

  // ── TOUCH HANDLERS ──────────────────────────────────────────────────
  const getSVGPoint = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const fraction = (clientX - rect.left - (rect.width * PAD.left / W)) / (rect.width * CW / W);
    return fraction;
  };

  const fractionToTime = (frac: number, v: ChartView) =>
    v.xMin + frac * (v.xMax - v.xMin);

  const onTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    const v = viewRef.current;
    if (!v) return;
    if (e.touches.length === 1) {
      touchRef.current = { type: "pan", startFrac: getSVGPoint(e.touches[0].clientX), view: { ...v } };
    } else if (e.touches.length === 2) {
      const f1 = getSVGPoint(e.touches[0].clientX);
      const f2 = getSVGPoint(e.touches[1].clientX);
      touchRef.current = {
        type: "pinch",
        startSpan: Math.abs(f2 - f1),
        startCenter: (f1 + f2) / 2,
        view: { ...v },
      };
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    const tc = touchRef.current;
    const v = tc?.view;
    if (!tc || !v) return;
    const fullMin = data[0]?.time  ?? 0;
    const fullMax = data[data.length - 1]?.time ?? 0;
    const span = v.xMax - v.xMin;

    if (tc.type === "pan" && e.touches.length >= 1) {
      const curFrac = getSVGPoint(e.touches[0].clientX);
      const dt = (tc.startFrac - curFrac) * span;
      let newMin = v.xMin + dt;
      let newMax = v.xMax + dt;
      if (newMin < fullMin) { newMin = fullMin; newMax = fullMin + span; }
      if (newMax > fullMax) { newMax = fullMax; newMin = fullMax - span; }
      setView({ xMin: newMin, xMax: newMax });

    } else if (tc.type === "pinch" && e.touches.length >= 2) {
      const f1 = getSVGPoint(e.touches[0].clientX);
      const f2 = getSVGPoint(e.touches[1].clientX);
      const curSpan   = Math.abs(f2 - f1);
      const curCenter = (f1 + f2) / 2;
      if (tc.startSpan < 0.02) return;
      const scale  = tc.startSpan / Math.max(curSpan, 0.01);
      const pivot  = fractionToTime(tc.startCenter, v);
      const newSpan = Math.min(fullMax - fullMin, Math.max(60000, span * scale));
      const shift  = (curCenter - tc.startCenter) * newSpan;
      let newMin = pivot - tc.startCenter * newSpan - shift;
      let newMax = newMin + newSpan;
      if (newMin < fullMin) { newMin = fullMin; newMax = fullMin + newSpan; }
      if (newMax > fullMax) { newMax = fullMax; newMin = fullMax - newSpan; }
      setView({ xMin: newMin, xMax: newMax });
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) {
      touchRef.current = null;
      setCrosshair(null);
    } else if (e.touches.length === 1 && touchRef.current?.type === "pinch") {
      // Downgrade pinch → pan
      const v = viewRef.current;
      if (!v) return;
      touchRef.current = { type: "pan", startFrac: getSVGPoint(e.touches[0].clientX), view: { ...v } };
    }
  };

  // Mouse crosshair (desktop)
  const onMouseMove = (e: React.MouseEvent) => {
    const v = viewRef.current;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!v || !rect || visible.length < 2) return;
    const frac = (e.clientX - rect.left - (rect.width * PAD.left / W)) / (rect.width * CW / W);
    const t = v.xMin + frac * (v.xMax - v.xMin);
    // Find nearest point
    let nearest = visible[0];
    let minDist = Infinity;
    for (const pt of visible) {
      const d = Math.abs(pt.time - t);
      if (d < minDist) { minDist = d; nearest = pt; }
    }
    const svgX = xScale(nearest.time);
    const svgY = yScale(nearest.value);
    setCrosshair({ x: svgX, y: svgY, value: nearest.value, time: nearest.time });
  };

  const onMouseLeave = () => setCrosshair(null);

  // Double-tap to reset
  const lastTapRef = useRef(0);
  const onTouchEndReset = (e: React.TouchEvent) => {
    onTouchEnd(e);
    if (e.touches.length === 0) {
      const now = Date.now();
      if (now - lastTapRef.current < 300 && data.length >= 2) {
        setView({ xMin: data[0].time, xMax: data[data.length - 1].time });
      }
      lastTapRef.current = now;
    }
  };

  const formatCrosshairTime = (ms: number) => {
    const d = new Date(ms);
    return d.toLocaleDateString("es", { day: "2-digit", month: "short" }) + " " +
      d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  };

  const gradId = `m2m-grad-${color.replace("#", "")}`;
  const span = view ? view.xMax - view.xMin : Infinity;
  const svgW = W;
  const lastPt = visible[visible.length - 1];

  if (data.length < 2) {
    return (
      <div style={{ height, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
        <div style={{ width: 42, height: 42, borderRadius: 10, background: "rgba(14,203,129,0.08)", border: "1px solid rgba(14,203,129,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontFamily: "var(--app-font-sans)", fontWeight: 900, fontSize: 15, color: TEAL, letterSpacing: "-1px" }}>M2</span>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "var(--app-font-sans)", fontWeight: 700, fontSize: 15, color: WHITE, marginBottom: 5 }}>Construyendo curva real</div>
          <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM, lineHeight: 1.8, letterSpacing: "0.06em" }}>Activa el bot para empezar a graficar</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", touchAction: "none", userSelect: "none" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEndReset}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${svgW} ${H}`}
        style={{ width: "100%", height, display: "block" }}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.38" />
            <stop offset="70%"  stopColor={color} stopOpacity="0.07" />
            <stop offset="100%" stopColor={color} stopOpacity="0.00" />
          </linearGradient>
          <clipPath id="chart-clip">
            <rect x={PAD.left} y={PAD.top} width={CW} height={CH} />
          </clipPath>
        </defs>

        {/* ── grid lines ── */}
        {yTicks.map(v => {
          const y = yScale(v);
          if (y < PAD.top || y > H - PAD.bottom) return null;
          return (
            <g key={v}>
              <line x1={PAD.left} y1={y} x2={PAD.left + CW} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="1" />
              <text x={PAD.left + CW + 4} y={y + 3.5} fontSize="7.5" fill={DIM} fontFamily="monospace">${v.toFixed(v < 1 ? 3 : 2)}</text>
            </g>
          );
        })}

        {/* ── area + line ── */}
        <g clipPath="url(#chart-clip)">
          {areaPath && <path d={areaPath} fill={`url(#${gradId})`} />}
          {linePath && <path d={linePath} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
        </g>

        {/* ── x-axis labels ── */}
        {xTicks.map((t, i) => {
          const x = xScale(t);
          if (x < PAD.left + 10 || x > PAD.left + CW - 10) return null;
          return (
            <text key={i} x={x} y={H - PAD.bottom + 14} fontSize="7.5" fill={DIM} fontFamily="monospace" textAnchor="middle">
              {formatAxisTime(t, span)}
            </text>
          );
        })}

        {/* ── last price label (right edge) ── */}
        {lastPt && (() => {
          const y = yScale(lastPt.value);
          return (
            <g>
              <line x1={PAD.left} y1={y} x2={PAD.left + CW} y2={y} stroke={color} strokeWidth="0.8" strokeDasharray="3,3" />
              <rect x={PAD.left + CW + 2} y={y - 8} width={54} height={16} rx="3" fill={color} opacity="0.9" />
              <text x={PAD.left + CW + 29} y={y + 3.5} fontSize="8.5" fill="#000" fontFamily="monospace" textAnchor="middle" fontWeight="700">
                {fmtUSD(lastPt.value)}
              </text>
            </g>
          );
        })()}

        {/* ── crosshair ── */}
        {crosshair && (() => {
          const { x, y, value, time } = crosshair;
          const labelW = 78;
          const labelH = 32;
          const lx = x > PAD.left + CW / 2 ? x - labelW - 8 : x + 8;
          const ly = y < PAD.top + labelH + 8 ? y + 8 : y - labelH - 8;
          return (
            <g>
              <line x1={x} y1={PAD.top} x2={x} y2={H - PAD.bottom} stroke={`${color}70`} strokeWidth="1" strokeDasharray="3,2" />
              <line x1={PAD.left} y1={y} x2={PAD.left + CW} y2={y} stroke={`${color}50`} strokeWidth="1" strokeDasharray="3,2" />
              <circle cx={x} cy={y} r="4" fill={color} stroke="rgba(255,255,255,0.8)" strokeWidth="1.5" />
              <rect x={lx} y={ly} width={labelW} height={labelH} rx="5" fill="rgba(13,20,33,0.97)" stroke={`${color}50`} strokeWidth="1" />
              <text x={lx + labelW / 2} y={ly + 12} fontSize="9.5" fill={color} fontFamily="monospace" textAnchor="middle" fontWeight="800">{fmtUSD(value)}</text>
              <text x={lx + labelW / 2} y={ly + 25} fontSize="7" fill={DIM} fontFamily="monospace" textAnchor="middle">{formatCrosshairTime(time)}</text>
            </g>
          );
        })()}
      </svg>

      {/* Hint */}
      <div style={{ position: "absolute", bottom: 4, left: "50%", transform: "translateX(-50%)", fontFamily: "var(--app-font-mono)", fontSize: 7, color: "rgba(255,255,255,0.08)", pointerEvents: "none", whiteSpace: "nowrap", letterSpacing: "0.06em" }}>
        PELLIZCA · ARRASTRA · DOBLE TAP RESET
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════════ */
export default function Curve() {
  const { bot: liveBot } = useBotStatus();
  const [bot, setBot]         = useState<any>(null);
  const [dbHistory, setDbHistory] = useState<{ time: number; balance: number }[]>([]);
  const [range, setRange]     = useState<Range>("ALL");

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

  useEffect(() => {
    let cancelled = false;
    const loadHistory = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/balance-history?days=90`);
        if (r.ok && !cancelled) {
          const data = await r.json();
          if (data.ok && Array.isArray(data.history)) setDbHistory(data.history);
        }
      } catch {}
    };
    loadHistory();
    const id = setInterval(loadHistory, 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const source    = bot ?? liveBot;
  const live      = !!source?.liveMode;
  const current   = live ? (source?.liveBalance ?? 0) : (source?.effectiveBalance ?? source?.simBalance ?? 0);
  const initial   = live ? (source?.liveInitialBalance ?? source?.initialBalance ?? 0) : (source?.initialBalance ?? 0);
  const available = live ? (source?.liveAvailable ?? current) : (source?.available ?? current);
  const tradeLog: any[] = source?.tradeLog ?? [];
  const totalFees   = Number(source?.totalFees ?? 0);
  const sessionPnl  = Number(source?.sessionPnl ?? 0);
  const sessionHistory: { time: number; balance: number }[] = source?.balanceHistory ?? [];
  const openPositions = Object.values(source?.openPositions ?? {}) as any[];
  const mpPairs   = source?.mpPairs ?? [];
  const openCount = openPositions.length + mpPairs.length;
  const totalUnreal = openPositions.reduce((s: number, p: any) => s + Number(p.unrealizedPnl ?? 0), 0);

  const wins   = tradeLog.filter((t: any) => t.pnl > 0).length;
  const losses = tradeLog.filter((t: any) => t.pnl < 0).length;
  const winRate   = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null;
  const bestTrade  = tradeLog.length ? Math.max(...tradeLog.map((t: any) => t.pnl)) : null;
  const worstTrade = tradeLog.length ? Math.min(...tradeLog.map((t: any) => t.pnl)) : null;

  // Merge DB + session history
  const fullHistory: ChartPoint[] = useMemo(() => {
    const db  = dbHistory.map(h => ({ time: h.time, value: h.balance }));
    if (db.length === 0) return sessionHistory.map(h => ({ time: h.time, value: h.balance }));
    const lastDbTime = db[db.length - 1].time;
    const newSession = sessionHistory.filter(p => p.time > lastDbTime).map(h => ({ time: h.time, value: h.balance }));
    return [...db, ...newSession];
  }, [dbHistory, sessionHistory]);

  // Dedup + sort
  const cleanHistory = useMemo(() => {
    const seen = new Set<number>();
    return fullHistory
      .filter(h => { if (seen.has(h.time)) return false; seen.add(h.time); return true; })
      .sort((a, b) => a.time - b.time);
  }, [fullHistory]);

  // Which ranges have data
  const availableRanges = useMemo(() => {
    if (cleanHistory.length < 2) return new Set<Range>(["ALL"]);
    const oldest = cleanHistory[0].time;
    const spanMs = Date.now() - oldest;
    const s = new Set<Range>(["ALL"]);
    RANGES.forEach(r => { if (r.ms !== Infinity && r.ms <= spanMs + 60000) s.add(r.label); });
    return s;
  }, [cleanHistory]);

  // Filter by selected range
  const rangeMs = RANGES.find(r => r.label === range)?.ms ?? Infinity;
  const filteredHistory = useMemo(() => {
    if (rangeMs === Infinity || cleanHistory.length === 0) return cleanHistory;
    const cutoff = Date.now() - rangeMs;
    const filtered = cleanHistory.filter(p => p.time >= cutoff);
    const before = cleanHistory.filter(p => p.time < cutoff);
    if (filtered.length < cleanHistory.length && before.length > 0) {
      return [before[before.length - 1], ...filtered];
    }
    return filtered;
  }, [cleanHistory, rangeMs]);

  const historyStart = filteredHistory.length > 0 ? filteredHistory[0].value : initial;
  const delta    = current - historyStart;
  const deltaPct = historyStart > 0 ? (delta / historyStart) * 100 : 0;
  const allTimeDelta = current - initial;
  const allTimePct   = initial > 0 ? (allTimeDelta / initial) * 100 : 0;
  const isUp     = delta >= 0;
  const accentColor = isUp ? TEAL : ROSE;

  const hasChart = filteredHistory.length >= 2;
  const recentTrades = tradeLog.slice().reverse().slice(0, 15);

  return (
    <Layout>
      <div style={{ maxWidth: 800, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10, paddingBottom: 24 }}>

        {/* ═══ HERO CARD ═══ */}
        <div style={{
          borderRadius: 14, overflow: "hidden",
          background: CARD,
          border: `1px solid ${isUp ? "rgba(14,203,129,0.18)" : "rgba(246,70,93,0.16)"}`,
        }}>

          {/* ── Balance header ── */}
          <div style={{ padding: "22px 20px 10px", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, fontWeight: 700, letterSpacing: "0.28em", textTransform: "uppercase" as const, color: isUp ? "rgba(14,203,129,0.45)" : "rgba(246,70,93,0.45)", marginBottom: 8 }}>
                {live ? "BYBIT MAINNET · EQUITY REAL" : "PAPER · EQUITY SIMULADO"}
              </div>
              <div style={{ fontFamily: "var(--app-font-sans)", fontWeight: 900, fontSize: 44, letterSpacing: "-3px", color: WHITE, lineHeight: 1 }}>
                {fmtUSD(current)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" as const }}>
                <span style={{ fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 15, color: accentColor }}>
                  {isUp ? "+" : ""}{fmtUSD(delta)}
                </span>
                <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, color: accentColor, opacity: 0.65 }}>
                  {isUp ? "+" : ""}{deltaPct.toFixed(2)}%
                </span>
                <span style={{
                  fontFamily: "var(--app-font-mono)", fontSize: 7, fontWeight: 700,
                  padding: "2px 7px", borderRadius: 5,
                  background: isUp ? "rgba(14,203,129,0.10)" : "rgba(246,70,93,0.10)",
                  color: isUp ? "rgba(14,203,129,0.65)" : "rgba(246,70,93,0.65)",
                  letterSpacing: "0.06em",
                }}>
                  {range !== "ALL" ? `ÚLTIMAS ${range}` : "HISTÓRICO TOTAL"}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, paddingTop: 2 }}>
              {live && (
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: AMBER, boxShadow: `0 0 8px ${AMBER}` }} />
                  <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, color: AMBER, letterSpacing: "0.12em", fontWeight: 700 }}>LIVE</span>
                </div>
              )}
              {available > 0 && (
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, color: MID, fontWeight: 600 }}>{fmtUSD(available)}</div>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 7, color: DIM, letterSpacing: "0.1em" }}>LIBRE</div>
                </div>
              )}
            </div>
          </div>

          {/* ── Range selector ── */}
          <div style={{ display: "flex", gap: 3, padding: "4px 20px 6px" }}>
            {RANGES.map(({ label }) => {
              const active  = range === label;
              const enabled = availableRanges.has(label);
              return (
                <button key={label} onClick={() => enabled && setRange(label)} style={{
                  flex: 1, padding: "6px 0", borderRadius: 7,
                  border: active ? `1px solid ${accentColor}55` : "1px solid transparent",
                  background: active ? `${accentColor}18` : "rgba(255,255,255,0.03)",
                  color: active ? accentColor : enabled ? DIM : "rgba(255,255,255,0.14)",
                  fontFamily: "var(--app-font-mono)", fontSize: 9,
                  fontWeight: active ? 800 : 500, cursor: enabled ? "pointer" : "default",
                  transition: "all 0.12s", letterSpacing: "0.02em",
                }}>
                  {label}
                </button>
              );
            })}
          </div>

          {/* ── Chart ── */}
          <M2MChart data={filteredHistory} color={accentColor} height={300} />

          {/* ── Footer stats ── */}
          {hasChart && (
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "8px 20px 14px",
              borderTop: "1px solid rgba(255,255,255,0.04)",
            }}>
              <div style={{ display: "flex", gap: 18 }}>
                {[
                  { l: "LO",       v: fmtUSD(Math.min(...filteredHistory.map(d => d.value))), c: ROSE },
                  { l: "HI",       v: fmtUSD(Math.max(...filteredHistory.map(d => d.value))), c: TEAL },
                  { l: "Δ SESIÓN", v: (sessionPnl >= 0 ? "+" : "") + fmtUSD(sessionPnl), c: sessionPnl >= 0 ? TEAL : ROSE },
                  { l: "TOTAL",    v: (allTimeDelta >= 0 ? "+" : "") + fmtUSD(allTimeDelta), c: allTimeDelta >= 0 ? TEAL : ROSE },
                ].map(({ l, v, c }) => (
                  <div key={l}>
                    <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 7, color: DIM, letterSpacing: "0.14em" }}>{l}</div>
                    <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, color: c, fontWeight: 700, marginTop: 2 }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, color: "rgba(255,255,255,0.18)" }}>{filteredHistory.length} pts</div>
                {cleanHistory.length > filteredHistory.length && (
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 7, color: "rgba(255,255,255,0.10)", marginTop: 1 }}>{cleanHistory.length} total</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ═══ STATS ═══ */}
        <div style={{ display: "flex", gap: 8 }}>
          <Chip label="Inicial"     value={fmtUSD(initial)} color={MID} />
          <Chip label="Actual"      value={fmtUSD(current)} color={TEAL} />
          <Chip
            label="Ganancia total"
            value={(allTimeDelta >= 0 ? "+" : "") + fmtUSD(allTimeDelta)}
            color={allTimeDelta >= 0 ? TEAL : ROSE}
            sub={(allTimePct >= 0 ? "+" : "") + allTimePct.toFixed(2) + "%"}
          />
        </div>

        {(winRate !== null || totalFees > 0 || openCount > 0 || bestTrade !== null) && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
            {winRate !== null && (
              <Chip label="Win Rate" value={`${winRate}%`}
                color={winRate >= 55 ? TEAL : winRate >= 40 ? AMBER : ROSE}
                sub={`${wins}W / ${losses}L`} />
            )}
            {totalFees > 0 && <Chip label="Fees total" value={"-" + fmtUSD(totalFees)} color={ROSE} />}
            {openCount > 0 && (
              <Chip label={`${openCount} Abierta${openCount > 1 ? "s" : ""}`}
                value={(totalUnreal >= 0 ? "+" : "") + fmtUSD(totalUnreal)}
                color={totalUnreal >= 0 ? TEAL : ROSE} sub="unrealized" />
            )}
            {bestTrade !== null && bestTrade > 0 && <Chip label="Mejor trade" value={"+" + fmtUSD(bestTrade)} color={TEAL} />}
            {worstTrade !== null && worstTrade < 0 && <Chip label="Peor trade" value={fmtUSD(worstTrade)} color={ROSE} />}
          </div>
        )}

        {/* ═══ TRADE LOG ═══ */}
        {recentTrades.length > 0 && (
          <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)", background: CARD }}>
            <div style={{
              display: "grid", gridTemplateColumns: "76px 1fr 56px 56px 88px 52px",
              padding: "9px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)",
              background: "rgba(255,255,255,0.02)",
            }}>
              {["RESULTADO", "SÍMBOLO", "LADO", "LEVA", "PnL", "HACE"].map(h => (
                <div key={h} style={{ fontFamily: "var(--app-font-mono)", fontSize: 7, fontWeight: 700, color: "rgba(255,255,255,0.18)", letterSpacing: "0.14em" }}>{h}</div>
              ))}
            </div>
            {recentTrades.map((t: any, i: number) => {
              const chip  = getReasonChip(t.closeReason ?? "");
              const isWin = t.pnl > 0;
              const coin  = (t.symbol ?? "").replace("USDT", "");
              return (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "76px 1fr 56px 56px 88px 52px",
                  padding: "10px 16px", alignItems: "center",
                  borderBottom: i < recentTrades.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none",
                }}>
                  <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "3px 7px", borderRadius: 5, background: chip.bg, width: "fit-content", fontFamily: "var(--app-font-mono)", fontSize: 8, fontWeight: 800, color: chip.fg, letterSpacing: "0.04em" }}>
                    {chip.label}
                  </div>
                  <div>
                    <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, fontWeight: 700, color: WHITE }}>{coin}</div>
                    {t.closeReason && <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 7, color: DIM, marginTop: 2 }}>{String(t.closeReason).slice(0, 24)}</div>}
                  </div>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, fontWeight: 700, color: t.direction === "LONG" ? TEAL : ROSE }}>{t.direction ?? "—"}</div>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: MID }}>{t.leverage ? `${t.leverage}x` : "—"}</div>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, fontWeight: 800, color: isWin ? TEAL : ROSE }}>
                    {t.pnl >= 0 ? "+" : ""}{fmtUSD(t.pnl, 4)}
                  </div>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, color: DIM }}>{t.closedAt ? timeAgo(t.closedAt) : "—"}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}
