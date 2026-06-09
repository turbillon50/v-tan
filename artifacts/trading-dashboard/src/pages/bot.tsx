import { useState, useEffect, useRef, useCallback } from "react";
import { Layout } from "@/components/layout";
import {
  useGetBotStatus, useToggleBot,
  useGetBalance, useGetPortfolioStats, useGetTrades,
} from "@workspace/api-client-react";
import { InfoIcon, PlayBtn, StopBtn, ClockIcon } from "@/components/TradeIcons";
import { BASE_URL } from "@/lib/api";
import { TanitReasoning } from "@/components/TanitReasoning";
import { TanitIdentity } from "@/components/TanitIdentity";
import { TanitLearning, type TanitLearningData } from "@/components/TanitLearning";

const GREEN  = "#00D4AA";
const RED    = "#F23645";
const AMBER  = "#FF9500";
const YELLOW = "#F5C518";

const SL_STAGE_CONFIG = [
  { label: "OPEN",        emoji: "⚪", color: "#8a98b3", bg: "rgba(138,152,179,0.10)", border: "rgba(138,152,179,0.25)" },
  { label: "BREAKEVEN",   emoji: "🟡", color: YELLOW,    bg: "rgba(245,197,24,0.10)",  border: "rgba(245,197,24,0.30)"  },
  { label: "33% LOCK",    emoji: "🟠", color: AMBER,     bg: "rgba(255,149,0,0.12)",   border: "rgba(255,149,0,0.35)"   },
  { label: "50% LOCK",    emoji: "🟢", color: GREEN,     bg: "rgba(0,212,170,0.12)",   border: "rgba(0,212,170,0.30)"   },
] as const;

function StageBadge({ stage }: { stage: 0 | 1 | 2 | 3 }) {
  const cfg = SL_STAGE_CONFIG[stage];
  return (
    <span style={{
      fontFamily: "var(--app-font-mono)", fontSize: 8, fontWeight: 700,
      padding: "2px 7px", borderRadius: 4,
      background: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
      letterSpacing: "0.06em",
    }}>
      {cfg.emoji} {cfg.label}
    </span>
  );
}

function RealBybitPositions() {
  const [positions, setPositions] = useState<any[]>([]);
  const [closing, setClosing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/bybit-positions`);
        if (r.ok && !cancelled) {
          const d = await r.json();
          setPositions(d.positions ?? []);
          setLastUpdate(Date.now());
        }
      } catch {}
    };
    load();
    const id = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const closeAll = async () => {
    if (!confirm("¿Cerrar TODAS las posiciones en Bybit ahora?")) return;
    setClosing(true);
    try {
      await fetch(`${BASE_URL}api/bot/close-all-bybit`, { method: "POST" });
      setTimeout(() => setPositions([]), 2000);
    } finally {
      setClosing(false);
    }
  };

  const closeOne = async (symbol: string, side: string) => {
    try {
      await fetch(`${BASE_URL}api/bot/close-bybit/${symbol}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side }),
      });
    } catch {}
  };

  if (positions.length === 0) return null;

  const totalPnl = positions.reduce((s, p) => s + parseFloat(p.unrealisedPnl ?? 0), 0);

  return (
    <div style={{
      borderRadius: 16,
      border: `1px solid ${totalPnl >= 0 ? "rgba(0,212,170,0.3)" : "rgba(242,54,69,0.4)"}`,
      background: totalPnl >= 0 ? "rgba(0,212,170,0.06)" : "rgba(242,54,69,0.07)",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px 10px",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: totalPnl >= 0 ? GREEN : RED, boxShadow: `0 0 8px ${totalPnl >= 0 ? GREEN : RED}` }} />
          <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: totalPnl >= 0 ? GREEN : RED }}>
            POSICIONES REALES BYBIT · {positions.length}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 13, fontWeight: 800, color: totalPnl >= 0 ? GREEN : RED }}>
            {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(4)} USDT
          </span>
          <button onClick={closeAll} disabled={closing}
            style={{
              background: "rgba(242,54,69,0.15)", border: "1px solid rgba(242,54,69,0.4)",
              color: RED, borderRadius: 8, padding: "4px 12px",
              fontFamily: "var(--app-font-mono)", fontSize: 10, fontWeight: 700,
              cursor: closing ? "not-allowed" : "pointer", opacity: closing ? 0.5 : 1,
            }}>
            {closing ? "CERRANDO..." : "⛔ CERRAR TODAS"}
          </button>
        </div>
      </div>

      {/* Positions */}
      {positions.map((p: any, i: number) => {
        const pnl = parseFloat(p.unrealisedPnl ?? 0);
        const side = p.side === "Buy" ? "LONG" : "SHORT";
        const sym = p.symbol?.replace("USDT", "") ?? p.symbol;
        const tp = p.initialTp != null ? parseFloat(p.initialTp) : null;
        const sl = p.currentSL != null ? parseFloat(p.currentSL) : null;
        const scaleIn = p.scaleInDone === true;
        const scaleInQty = p.scaleInQty != null ? parseFloat(p.scaleInQty) : null;
        const slStage: 0 | 1 | 2 | 3 = (p.slStage as 0 | 1 | 2 | 3) ?? 0;
        return (
          <div key={i} style={{
            padding: "10px 16px",
            borderBottom: i < positions.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
          }}>
            {/* symbol + badges + PnL + close button */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 13, color: "#fff" }}>{sym}</span>
                  <span style={{
                    fontFamily: "var(--app-font-mono)", fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                    background: side === "LONG" ? "rgba(0,212,170,0.12)" : "rgba(242,54,69,0.12)",
                    color: side === "LONG" ? GREEN : RED,
                    border: `1px solid ${side === "LONG" ? "rgba(0,212,170,0.25)" : "rgba(242,54,69,0.25)"}`,
                  }}>{side}</span>
                  <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: "#8a98b3" }}>{p.leverage}x</span>
                  <StageBadge stage={slStage} />
                  {scaleIn && (
                    <span style={{
                      fontFamily: "var(--app-font-mono)", fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                      background: "rgba(255,149,0,0.15)", color: AMBER,
                      border: "1px solid rgba(255,149,0,0.35)", letterSpacing: "0.06em",
                    }}>🚀 SCALE-IN</span>
                  )}
                </div>
                <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: "#6a7890" }}>
                  Entry {parseFloat(p.avgPrice).toFixed(5)} · Size {p.size}
                  {scaleIn && scaleInQty != null && scaleInQty > 0 && (
                    <span style={{ color: AMBER, marginLeft: 4 }}>
                      (+{scaleInQty.toFixed(4)} added)
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 14, color: pnl >= 0 ? GREEN : RED }}>
                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)}
                  </div>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: "#6a7890" }}>USDT</div>
                </div>
                <button onClick={() => closeOne(p.symbol, side)}
                  style={{
                    background: "rgba(255,149,0,0.12)", border: "1px solid rgba(255,149,0,0.3)",
                    color: AMBER, borderRadius: 7, padding: "3px 10px",
                    fontFamily: "var(--app-font-mono)", fontSize: 9, fontWeight: 700, cursor: "pointer",
                  }}>
                  CERRAR
                </button>
              </div>
            </div>
            {/* TP (green) and SL (red) targets */}
            {(tp != null || (sl != null && sl > 0)) && (
              <div style={{ display: "flex", gap: 14, marginTop: 5, flexWrap: "wrap" }}>
                {tp != null && (
                  <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: GREEN }}>
                    TP {tp.toFixed(5)}
                  </span>
                )}
                {sl != null && sl > 0 && (
                  <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: RED }}>
                    SL {sl.toFixed(5)}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const ESCALON_TIERS = [
  { label: "Punta",  leverage: 50,  weight: 15, sl: "1.3%", tp: "3.8%", color: RED,   desc: "Posición de mayor convicción. Entra primero, salida rápida." },
  { label: "Medio",  leverage: 25,  weight: 35, sl: "1.8%", tp: "5.0%", color: AMBER, desc: "Posición de soporte. Balance entre riesgo y duración." },
  { label: "Ancla",  leverage: 10,  weight: 50, sl: "2.5%", tp: "6.5%", color: GREEN, desc: "Posición principal. Mayor capital, menor exposición." },
];

function StatCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="card-glass p-4">
      <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">{label}</div>
      <div className="text-xl font-bold font-mono tabular-nums" style={{ color: color ?? "hsl(var(--foreground))" }}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function SessionTimer({ remainingMs, isInBreak, breakRemainingMs }: { remainingMs: number; isInBreak: boolean; breakRemainingMs: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (isInBreak) {
    const bSec = Math.max(0, Math.round(breakRemainingMs / 1000) - tick);
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full" style={{ background: AMBER }} />
        <span className="text-[11px] font-mono" style={{ color: AMBER }}>
          Descanso {bSec}s — re-analizando mercado
        </span>
      </div>
    );
  }

  const totalSec = Math.max(0, Math.round(remainingMs / 1000) - tick);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const pct = Math.max(0, Math.min(100, (totalSec / (30 * 60)) * 100));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">Tiempo restante sesión</span>
        <span className="font-mono font-bold" style={{ color: GREEN }}>
          {min}:{sec.toString().padStart(2, "0")}
        </span>
      </div>
      <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: GREEN }} />
      </div>
    </div>
  );
}

const SESSION_QUALITY_COLOR: Record<string, string> = {
  ELITE:  "#00D4AA",
  HIGH:   "#00D4AA",
  MEDIUM: "#FF9500",
  LOW:    "#FF9500",
  DEAD:   "#F23645",
};

const SESSION_HOURS: Record<string, string> = {
  "Late Night":        "00-04",
  "Asia":              "04-08",
  "London":            "08-13",
  "London+NY Overlap": "13-16",
  "NY Peak":           "16-21",
  "NY Late":           "21-24",
};

function sessionMultColor(mult: number): string {
  if (mult <= 1.00) return "#00D4AA";
  if (mult <= 1.10) return "#FF9500";
  return "#F23645";
}

// ── Hook: carga el mapa de ballenas (caché 30min en servidor) ─────────────────
function useWhalePattern() {
  const [data, setData]     = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    fetch("/api/bot/whalepattern")
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return { data, loading };
}

const BIAS_COLOR: Record<string, string> = {
  STRONG_BULL: "#00D4AA",
  BULL:        "#00A882",
  NEUTRAL:     "#3a3a4a",
  BEAR:        "#922020",
  STRONG_BEAR: "#F23645",
};

const BIAS_TEXT: Record<string, string> = {
  STRONG_BULL: "#00D4AA",
  BULL:        "#00D4AA",
  NEUTRAL:     "#666680",
  BEAR:        "#F23645",
  STRONG_BEAR: "#F23645",
};

function WhalePatternMap() {
  const { data, loading } = useWhalePattern();

  if (loading) {
    return (
      <div className="card-glass p-5">
        <h2 className="font-bold text-sm text-foreground mb-1">Mapa Horario de Ballenas</h2>
        <p className="text-[11px] text-muted-foreground mb-3">
          Cargando patrones históricos desde Bybit — análisis de 120 velas...
        </p>
        <div className="h-1 w-32 rounded-full bg-muted/30 overflow-hidden">
          <div className="h-full rounded-full bg-primary/60" style={{ width: "60%", transition: "width 1s" }} />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const nowCancun: number = data.hora_actual_cancun;
  // Ordenar por hora Cancún
  const hours: any[] = [...(data.consenso ?? [])].sort((a: any, b: any) => a.hCancun - b.hCancun);

  // Calcular max vol para normalizar la barra
  const maxVol = Math.max(...hours.map((h: any) => h.volRatio), 1);

  // Contar horas por bias para el resumen
  const sBull = hours.filter((h: any) => h.bias === "STRONG_BULL").length;
  const bull   = hours.filter((h: any) => h.bias === "BULL").length;
  const sBear  = hours.filter((h: any) => h.bias === "STRONG_BEAR").length;
  const bear   = hours.filter((h: any) => h.bias === "BEAR").length;

  return (
    <div className="card-glass p-5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="font-bold text-sm text-foreground">Mapa Horario de Ballenas</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Patrón estadístico por hora — últimos 5 días, 6 monedas. Hora Cancún (CDT).
          </p>
        </div>
        <div className="flex gap-3 text-[10px] shrink-0">
          <span className="font-mono" style={{ color: GREEN }}>{sBull + bull} alcistas</span>
          <span className="text-muted-foreground/40">|</span>
          <span className="font-mono" style={{ color: RED }}>{sBear + bear} bajistas</span>
          <span className="text-muted-foreground/40">|</span>
          <span className="font-mono text-muted-foreground">{24 - sBull - bull - sBear - bear} neutras</span>
        </div>
      </div>

      {/* Heatmap horizontal — 24 filas */}
      <div className="space-y-[3px]">
        {hours.map((h: any) => {
          const isNow = h.hCancun === nowCancun;
          const barPct = Math.min(100, (h.volRatio / maxVol) * 100);
          const bullPctBar = Math.min(100, Math.max(0, (h.bullPct - 30) / 40 * 100)); // escala 30-70% → 0-100%
          const retStr = (h.avgRet >= 0 ? "+" : "") + h.avgRet.toFixed(3) + "%";
          const hStr = String(h.hCancun).padStart(2, "0");
          const biasLabel = h.bias === "STRONG_BULL" ? "BULL+" : h.bias === "BULL" ? "BULL"
            : h.bias === "STRONG_BEAR" ? "BEAR+" : h.bias === "BEAR" ? "BEAR" : "—";

          return (
            <div
              key={h.hCancun}
              className="relative flex items-center gap-2 rounded-lg px-3 py-1.5 overflow-hidden transition-colors"
              style={{
                background: isNow
                  ? "rgba(0,212,170,0.07)"
                  : "rgba(255,255,255,0.02)",
                border: isNow ? "1px solid rgba(0,212,170,0.2)" : "1px solid transparent",
              }}>
              {/* Barra de volumen de fondo */}
              <div className="absolute inset-0 left-0"
                style={{
                  width: `${barPct}%`,
                  background: BIAS_COLOR[h.bias] + "12",
                  transition: "width 0.5s",
                }} />

              {/* Hora */}
              <div className="relative z-10 font-mono text-[11px] w-12 shrink-0"
                style={{ color: isNow ? GREEN : "hsl(var(--muted-foreground))" }}>
                {hStr}:00{isNow && <span className="ml-1 text-[8px] font-bold">NOW</span>}
              </div>

              {/* Mini barra de bull% */}
              <div className="relative z-10 flex-1 h-1.5 bg-muted/30 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all"
                  style={{
                    width: `${bullPctBar}%`,
                    background: BIAS_COLOR[h.bias] === "#3a3a4a" ? "#555" : BIAS_COLOR[h.bias],
                  }} />
              </div>

              {/* Bull% */}
              <div className="relative z-10 font-mono text-[10px] w-10 text-right shrink-0"
                style={{ color: BIAS_TEXT[h.bias] }}>
                {h.bullPct.toFixed(0)}%
              </div>

              {/* Retorno promedio */}
              <div className="relative z-10 font-mono text-[10px] w-14 text-right shrink-0"
                style={{ color: h.avgRet >= 0.05 ? GREEN : h.avgRet <= -0.05 ? RED : "hsl(var(--muted-foreground))" }}>
                {retStr}
              </div>

              {/* Vol ratio */}
              <div className="relative z-10 text-[9px] w-8 text-right text-muted-foreground/50 shrink-0 font-mono">
                {h.volRatio.toFixed(1)}x
              </div>

              {/* Bias badge */}
              <div className="relative z-10 w-12 text-right shrink-0">
                {biasLabel !== "—" && (
                  <span className="text-[8px] font-bold px-1 py-0.5 rounded"
                    style={{ background: BIAS_COLOR[h.bias] + "20", color: BIAS_TEXT[h.bias] }}>
                    {biasLabel}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Leyenda */}
      <div className="flex items-center gap-4 mt-4 pt-3 border-t border-muted/20 text-[10px] text-muted-foreground">
        <span>Barra = volumen relativo</span>
        <span>% = % de velas alcistas (5 días)</span>
        <span>ret = retorno promedio por hora</span>
      </div>
    </div>
  );
}

// ── SWAP HISTORY — muestra swaps de posición recientes ───────────────────────
interface SwapEvent {
  ts: number;
  closedSymbol: string;
  closedScore: number;
  closedPnl: number;
  openedSymbol: string;
  openedScore: number;
  advantage: number;
  success: boolean;
  reason: string;
  outcomePnl?: number;
}

interface RejectedAttempt {
  ts: number;
  reason: "chat_id_mismatch" | "user_id_not_allowed" | "rate_limited";
  chatId: string;
  userId: string;
  username?: string;
}

const REASON_LABELS: Record<string, string> = {
  chat_id_mismatch:    "Chat no autorizado",
  user_id_not_allowed: "Usuario no permitido",
  rate_limited:        "Rate limit excedido",
};
const REASON_COLORS: Record<string, string> = {
  chat_id_mismatch:    "#F23645",
  user_id_not_allowed: "#F5A623",
  rate_limited:        "#7C4DFF",
};

function TelegramAuditPanel() {
  const [attempts, setAttempts] = useState<RejectedAttempt[]>([]);
  const [clearing, setClearing] = useState(false);

  const load = async () => {
    try {
      const r = await fetch(`${BASE_URL}api/bot/tg-audit`);
      if (r.ok) {
        const d = await r.json();
        setAttempts(d.attempts ?? []);
      }
    } catch {}
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const clearAll = async () => {
    setClearing(true);
    try {
      await fetch(`${BASE_URL}api/bot/tg-audit`, { method: "DELETE" });
      setAttempts([]);
    } finally {
      setClearing(false);
    }
  };

  if (attempts.length === 0) return null;

  return (
    <div className="px-4 pb-4 space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#F23645" }}>
          🛡️ Seguridad Telegram
        </h2>
        <button
          onClick={clearAll}
          disabled={clearing}
          className="text-xs px-2 py-1 rounded opacity-70 hover:opacity-100 transition-opacity"
          style={{ background: "#1a1a2e", color: "#F23645", border: "1px solid #F2364540" }}
        >
          {clearing ? "Limpiando…" : "Limpiar"}
        </button>
      </div>
      <div className="rounded-xl overflow-hidden" style={{ background: "#0D0B1A", border: "1px solid #F2364520" }}>
        {attempts.slice(0, 20).map((a, i) => {
          const color = REASON_COLORS[a.reason] ?? "#888";
          const label = REASON_LABELS[a.reason] ?? a.reason;
          const when = new Date(a.ts).toLocaleString("es-MX", { timeZone: "America/Cancun", hour: "2-digit", minute: "2-digit", second: "2-digit" });
          return (
            <div key={i} className="flex items-center gap-2 px-3 py-2 text-xs" style={{ borderBottom: i < attempts.length - 1 ? "1px solid #ffffff08" : "none" }}>
              <span className="font-mono" style={{ color: "#888", flexShrink: 0 }}>{when}</span>
              <span className="rounded px-1.5 py-0.5 font-semibold" style={{ background: `${color}20`, color }}>{label}</span>
              <span className="font-mono truncate" style={{ color: "#aaa" }}>
                chat:{a.chatId} uid:{a.userId}{a.username ? ` @${a.username}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SwapHistory({
  swaps,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  swaps: SwapEvent[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  if (swaps.length === 0) return null;

  return (
    <div className="px-4 pb-4 space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-widest" style={{ color: "#FF9500" }}>
        ♻️ Swaps de Posición
      </h2>
      <div className="card-glass p-5">
        <p className="text-[11px] text-muted-foreground mb-3">
          Cambios de posición ejecutados por Tanit — cerró una débil para entrar en una mejor oportunidad.
        </p>
        <div className="space-y-2">
          {swaps.map((s, i) => {
            const pnlColor = s.closedPnl >= 0 ? GREEN : RED;
            const pnlStr = (s.closedPnl >= 0 ? "+" : "") + "$" + s.closedPnl.toFixed(3);
            const timeStr = new Date(s.ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            const dateStr = new Date(s.ts).toLocaleDateString("es", { day: "2-digit", month: "2-digit" });

            return (
              <div
                key={i}
                style={{
                  background: s.success ? "rgba(0,212,170,0.04)" : "rgba(242,54,69,0.04)",
                  border: `1px solid ${s.success ? "rgba(0,212,170,0.15)" : "rgba(242,54,69,0.15)"}`,
                  borderRadius: 12,
                  padding: "10px 14px",
                }}
              >
                {/* Header row */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{
                      fontFamily: "var(--app-font-mono)", fontSize: 9, fontWeight: 700,
                      padding: "2px 7px", borderRadius: 4,
                      background: "rgba(255,149,0,0.15)",
                      color: AMBER,
                      border: "1px solid rgba(255,149,0,0.3)",
                      letterSpacing: "0.1em",
                    }}>
                      SWAP
                    </span>
                    <span style={{
                      fontFamily: "var(--app-font-mono)", fontSize: 9,
                      padding: "2px 7px", borderRadius: 4,
                      background: s.success ? "rgba(0,212,170,0.1)" : "rgba(242,54,69,0.1)",
                      color: s.success ? GREEN : RED,
                      border: `1px solid ${s.success ? "rgba(0,212,170,0.2)" : "rgba(242,54,69,0.2)"}`,
                    }}>
                      {s.success ? "COMPLETADO" : "PARCIAL"}
                    </span>
                  </div>
                  <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: "#6a7890" }}>
                    {dateStr} {timeStr}
                  </span>
                </div>

                {/* Swap detail row */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {/* Closed symbol */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 5,
                    background: "rgba(242,54,69,0.08)", borderRadius: 8, padding: "5px 10px",
                    border: "1px solid rgba(242,54,69,0.15)",
                  }}>
                    <span style={{ fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 13, color: "#fff" }}>
                      {s.closedSymbol}
                    </span>
                    <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: "#8a98b3" }}>
                      score={s.closedScore.toFixed(0)}
                    </span>
                    <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, fontWeight: 700, color: pnlColor }}>
                      {pnlStr}
                    </span>
                  </div>

                  {/* Arrow */}
                  <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 14, color: AMBER }}>→</span>

                  {/* Opened symbol */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 5,
                    background: "rgba(0,212,170,0.08)", borderRadius: 8, padding: "5px 10px",
                    border: "1px solid rgba(0,212,170,0.15)",
                  }}>
                    <span style={{ fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 13, color: "#fff" }}>
                      {s.openedSymbol}
                    </span>
                    <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: "#8a98b3" }}>
                      score={s.openedScore.toFixed(0)}
                    </span>
                    <span style={{
                      fontFamily: "var(--app-font-mono)", fontSize: 10, fontWeight: 700,
                      color: GREEN, background: "rgba(0,212,170,0.12)",
                      padding: "1px 6px", borderRadius: 4,
                    }}>
                      +{s.advantage.toFixed(0)} pts
                    </span>
                  </div>
                </div>

                {/* Reason text + outcome */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 5, flexWrap: "wrap", gap: 4 }}>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: "#6a7890" }}>
                    {s.reason}
                  </div>
                  {s.outcomePnl !== undefined && (
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: "#6a7890" }}>resultado:</span>
                      <span style={{
                        fontFamily: "var(--app-font-mono)", fontSize: 11, fontWeight: 700,
                        color: s.outcomePnl >= 0 ? GREEN : RED,
                        background: s.outcomePnl >= 0 ? "rgba(0,212,170,0.12)" : "rgba(242,54,69,0.12)",
                        padding: "2px 8px", borderRadius: 5,
                        border: `1px solid ${s.outcomePnl >= 0 ? "rgba(0,212,170,0.25)" : "rgba(242,54,69,0.25)"}`,
                      }}>
                        {s.outcomePnl >= 0 ? "+" : ""}${s.outcomePnl.toFixed(4)}
                      </span>
                    </div>
                  )}
                  {s.success && s.outcomePnl === undefined && (
                    <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: "#6a7890", fontStyle: "italic" }}>
                      en curso…
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {hasMore && onLoadMore && (
          <div style={{ display: "flex", justifyContent: "center", paddingTop: 14 }}>
            <button
              onClick={onLoadMore}
              disabled={loadingMore}
              style={{
                fontFamily: "var(--app-font-mono)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.08em",
                padding: "7px 22px",
                borderRadius: 8,
                border: `1px solid ${AMBER}40`,
                background: `${AMBER}10`,
                color: AMBER,
                opacity: loadingMore ? 0.5 : 1,
                cursor: loadingMore ? "not-allowed" : "pointer",
                transition: "opacity 0.2s",
              }}
            >
              {loadingMore ? "Cargando…" : "Cargar más"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── GEMINI COMMAND BAR — barra de chat estilo Claude con control del bot ──────
interface ChatMessage {
  role: "user" | "ai";
  text: string;
  actions?: string[];
  ts: number;
}

interface ScaleInNotification {
  key: number;
  text: string;
}

function GeminiCommandBar({ isRunning, onToggle, togglePending, notifications }: {
  isRunning: boolean;
  onToggle: () => void;
  togglePending: boolean;
  notifications?: ScaleInNotification[];
}) {
  const [input, setInput]       = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending]   = useState(false);
  const [open, setOpen]         = useState(false);
  const [listening, setListening] = useState(false);
  const inputRef  = useRef<HTMLTextAreaElement>(null);
  const chatRef   = useRef<HTMLDivElement>(null);
  const recognRef = useRef<any>(null);
  const seenNotifRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!notifications || notifications.length === 0) return;
    const fresh = notifications.filter(n => !seenNotifRef.current.has(n.key));
    if (fresh.length === 0) return;
    fresh.forEach(n => seenNotifRef.current.add(n.key));
    setMessages(prev => [
      ...prev,
      ...fresh.map(n => ({ role: "ai" as const, text: n.text, ts: n.key })),
    ]);
    setOpen(true);
  }, [notifications]);

  // Auto-scroll al último mensaje
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  const send = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || sending) return;
    setInput("");
    setSending(true);
    setOpen(true);
    setMessages(prev => [...prev, { role: "user", text: msg, ts: Date.now() }]);
    try {
      const r = await fetch(`${BASE_URL}api/bot/gemini-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const d = await r.json();
      setMessages(prev => [...prev, {
        role: "ai",
        text: d.reply ?? "Sin respuesta.",
        actions: d.actionsExecuted ?? [],
        ts: Date.now(),
      }]);
    } catch {
      setMessages(prev => [...prev, { role: "ai", text: "Error de conexión.", ts: Date.now() }]);
    } finally {
      setSending(false);
    }
  }, [input, sending]);

  const startVoice = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { alert("Tu navegador no soporta voz."); return; }
    if (listening) { recognRef.current?.stop(); setListening(false); return; }
    const r = new SpeechRecognition();
    r.lang = "es-MX";
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onstart  = () => setListening(true);
    r.onend    = () => setListening(false);
    r.onerror  = () => setListening(false);
    r.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setInput(transcript);
      setTimeout(() => send(transcript), 100);
    };
    recognRef.current = r;
    r.start();
  }, [listening, send]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50, pointerEvents: "none" }}>
      {/* Chat history — aparece sobre la barra */}
      {open && messages.length > 0 && (
        <div style={{ pointerEvents: "auto", maxWidth: 760, margin: "0 auto 0", padding: "0 16px" }}>
          <div ref={chatRef} style={{
            maxHeight: 280,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "12px 0 4px",
          }}>
            {messages.map((m, i) => (
              <div key={i} style={{
                display: "flex",
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              }}>
                {m.role === "ai" && (
                  <div style={{
                    width: 26, height: 26, borderRadius: "50%", flexShrink: 0, marginRight: 8,
                    background: "linear-gradient(135deg,#00E5CC,#00A882)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 800, color: "#030810",
                  }}>M</div>
                )}
                <div style={{
                  maxWidth: "72%",
                  padding: "9px 14px",
                  borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                  background: m.role === "user"
                    ? "linear-gradient(135deg,rgba(0,229,204,0.18),rgba(0,229,204,0.10))"
                    : "rgba(15,22,40,0.92)",
                  border: m.role === "user"
                    ? "1px solid rgba(0,229,204,0.25)"
                    : "1px solid rgba(255,255,255,0.08)",
                  backdropFilter: "blur(16px)",
                  fontSize: 13,
                  color: m.role === "user" ? "#e0fff8" : "#c8d8f0",
                  lineHeight: 1.45,
                }}>
                  {m.text}
                  {m.role === "ai" && m.actions && m.actions.length > 0 && (
                    <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {m.actions.map((a, j) => (
                        <span key={j} style={{
                          fontSize: 10, padding: "2px 8px", borderRadius: 20,
                          background: "rgba(0,229,204,0.12)", color: "#00E5CC",
                          border: "1px solid rgba(0,229,204,0.2)",
                        }}>✓ {a}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{
                  width: 26, height: 26, borderRadius: "50%",
                  background: "linear-gradient(135deg,#00E5CC,#00A882)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 800, color: "#030810",
                }}>M</div>
                <div style={{
                  padding: "9px 14px", borderRadius: "18px 18px 18px 4px",
                  background: "rgba(15,22,40,0.92)", border: "1px solid rgba(255,255,255,0.08)",
                  backdropFilter: "blur(16px)",
                }}>
                  <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    {[0,1,2].map(i => (
                      <span key={i} style={{
                        width: 6, height: 6, borderRadius: "50%",
                        background: "#00E5CC", opacity: 0.7,
                        animation: `pulse 1.2s ease-in-out ${i*0.2}s infinite`,
                      }} />
                    ))}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Barra principal */}
      <div style={{
        pointerEvents: "auto",
        background: "rgba(3,8,16,0.85)",
        backdropFilter: "blur(24px)",
        borderTop: "1px solid rgba(255,255,255,0.07)",
        padding: "12px 16px 16px",
      }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", alignItems: "flex-end", gap: 10 }}>

          {/* BOTÓN TOGGLE — izquierda */}
          <button
            onClick={onToggle}
            disabled={togglePending}
            title={isRunning ? "Detener bot" : "Iniciar bot"}
            style={{
              flexShrink: 0,
              width: 44, height: 44,
              borderRadius: 14,
              border: isRunning
                ? "1px solid rgba(242,54,69,0.4)"
                : "1px solid rgba(0,229,204,0.4)",
              background: isRunning
                ? "rgba(242,54,69,0.12)"
                : "rgba(0,229,204,0.12)",
              color: isRunning ? "#F23645" : "#00E5CC",
              cursor: togglePending ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              opacity: togglePending ? 0.5 : 1,
              transition: "all 0.2s",
              fontSize: 18,
            }}>
            {isRunning ? "⏹" : "▶"}
          </button>

          {/* INPUT AREA */}
          <div style={{
            flex: 1,
            position: "relative",
            borderRadius: 18,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.04)",
            display: "flex", alignItems: "flex-end",
            transition: "border-color 0.2s",
          }}
            onFocus={() => {}} // just for styling
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
              onKeyDown={handleKey}
              placeholder="Dile algo a M2M... (ej: 'recalibra umbrales' o 'cierra todo')"
              rows={1}
              style={{
                flex: 1,
                resize: "none",
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#e8f0ff",
                fontSize: 14,
                lineHeight: 1.5,
                padding: "11px 12px 11px 16px",
                fontFamily: "inherit",
                minHeight: 44,
                maxHeight: 120,
                overflowY: "auto",
                caretColor: "#00E5CC",
              }}
            />

            {/* Botones derecha dentro del input */}
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", flexShrink: 0 }}>
              {/* Voz */}
              <button
                onClick={startVoice}
                title={listening ? "Parar voz" : "Hablar"}
                style={{
                  width: 32, height: 32, borderRadius: 10,
                  border: listening ? "1px solid rgba(255,149,0,0.6)" : "1px solid transparent",
                  background: listening ? "rgba(255,149,0,0.15)" : "transparent",
                  color: listening ? "#FF9500" : "rgba(255,255,255,0.35)",
                  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16, transition: "all 0.2s",
                }}>
                {listening ? "⏺" : "🎙"}
              </button>

              {/* Enviar */}
              <button
                onClick={() => send()}
                disabled={!input.trim() || sending}
                style={{
                  width: 32, height: 32, borderRadius: 10,
                  border: "none",
                  background: input.trim() && !sending
                    ? "linear-gradient(135deg,#00E5CC,#00A882)"
                    : "rgba(255,255,255,0.06)",
                  color: input.trim() && !sending ? "#030810" : "rgba(255,255,255,0.2)",
                  cursor: input.trim() && !sending ? "pointer" : "not-allowed",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 14, fontWeight: 800, transition: "all 0.2s",
                }}>
                ↑
              </button>
            </div>
          </div>

          {/* Indicador TANIT */}
          <div style={{
            flexShrink: 0,
            width: 44, height: 44,
            borderRadius: 14,
            background: "linear-gradient(135deg,rgba(0,229,204,0.15),rgba(0,168,130,0.08))",
            border: "1px solid rgba(0,229,204,0.2)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 2,
          }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#00E5CC", letterSpacing: "0.05em" }}>M2M</span>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#00E5CC", opacity: 0.8 }} />
          </div>
        </div>

        {/* Hint */}
        <div style={{
          maxWidth: 760, margin: "6px auto 0",
          textAlign: "center",
          fontSize: 10,
          color: "rgba(255,255,255,0.2)",
          letterSpacing: "0.03em",
        }}>
          M2M · Powered by Gemini AI · Control total del sistema
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%,100% { opacity:0.3; transform:scale(0.8); }
          50% { opacity:1; transform:scale(1.1); }
        }
      `}</style>
    </div>
  );
}

function TanitParamsPanel() {
  const [params, setParams] = useState<Record<string, { value: number | string; label: string; group: string; unit?: string }> | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/live-params`);
        if (r.ok && !cancelled) {
          const d = await r.json();
          setParams(d.params ?? null);
        }
      } catch {}
    };
    load();
    const id = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!params) return null;

  const GROUPS: { key: string; label: string; color: string }[] = [
    { key: "fase4",    label: "FASE 4 · Auto-reprogramación", color: "#00E5CC" },
    { key: "strategy", label: "ESTRATEGIA",                   color: "#8B5CF6" },
    { key: "leaps",    label: "MOMENTUM LEAPS",               color: "#F5A623" },
  ];

  const grouped = GROUPS.map(g => ({
    ...g,
    items: Object.entries(params).filter(([, v]) => v.group === g.key),
  })).filter(g => g.items.length > 0);

  return (
    <div style={{
      borderRadius: 12,
      border: open ? "1px solid rgba(0,229,204,0.18)" : "1px solid rgba(255,255,255,0.07)",
      background: open ? "rgba(0,229,204,0.03)" : "rgba(255,255,255,0.015)",
      transition: "all 0.2s",
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", background: "none", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px",
        }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.18em", color: "#00E5CC", fontFamily: "var(--app-font-mono)" }}>
            PARÁMETROS EN VIVO
          </span>
          <span style={{
            fontSize: 8, padding: "1px 6px", borderRadius: 6,
            background: "rgba(0,229,204,0.08)", color: "rgba(0,229,204,0.6)",
            border: "1px solid rgba(0,229,204,0.15)", fontFamily: "var(--app-font-mono)", fontWeight: 700,
          }}>FASE 4</span>
        </div>
        <span style={{ color: "rgba(255,255,255,0.25)", fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          {grouped.map(g => (
            <div key={g.key}>
              <div style={{
                fontSize: 8, fontWeight: 700, letterSpacing: "0.14em",
                color: `${g.color}80`, fontFamily: "var(--app-font-mono)",
                marginBottom: 6,
              }}>{g.label}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 6 }}>
                {g.items.map(([key, v]) => (
                  <div key={key} style={{
                    borderRadius: 8,
                    border: `1px solid ${g.color}18`,
                    background: `${g.color}05`,
                    padding: "6px 8px",
                  }}>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", fontFamily: "var(--app-font-mono)", marginBottom: 2, lineHeight: 1.3 }}>
                      {v.label}
                    </div>
                    <div style={{
                      fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 14,
                      color: g.color, lineHeight: 1,
                    }}>
                      {v.value}{v.unit ? <span style={{ fontSize: 9, fontWeight: 400, color: `${g.color}80`, marginLeft: 2 }}>{v.unit}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SESSION_DEFS = [
  { name: "Late Night",        abbr: "Late Night",  start: 0,  end: 4,  defaultMult: 1.20, color: "#4a5568" },
  { name: "Asia",              abbr: "Asia",        start: 4,  end: 8,  defaultMult: 1.20, color: "#6B7FA3" },
  { name: "London",            abbr: "London",      start: 8,  end: 13, defaultMult: 1.00, color: "#60A5FA" },
  { name: "London+NY Overlap", abbr: "L+NY ×0.85", start: 13, end: 16, defaultMult: 0.85, color: "#00D4AA" },
  { name: "NY Peak",           abbr: "NY Peak",     start: 16, end: 21, defaultMult: 1.00, color: "#60A5FA" },
  { name: "NY Late",           abbr: "NY Late",     start: 21, end: 24, defaultMult: 1.10, color: "#FF9500" },
] as const;

type SessionStat = { session: string; winRate: number; avgPnl: number; count: number };

const ALERT_LEAD_KEY      = "lnny_alert_lead_mins";
const ALERT_DISMISSED_KEY = "lnny_alert_dismissed_date";

function SessionTimeline() {
  const [now, setNow] = useState(() => new Date());
  const [sessionStats, setSessionStats] = useState<SessionStat[]>([]);
  const [alertLeadMins, setAlertLeadMins] = useState<number>(() => {
    const saved = localStorage.getItem(ALERT_LEAD_KEY);
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return !isNaN(parsed) && parsed >= 1 && parsed <= 240 ? parsed : 30;
  });
  const [editingLead, setEditingLead] = useState(false);
  const [leadInput, setLeadInput] = useState<string>("");
  const leadInputRef = useRef<HTMLInputElement>(null);
  const leadSavingRef = useRef(false);
  const [dismissedDate, setDismissedDate] = useState<string>(
    () => localStorage.getItem(ALERT_DISMISSED_KEY) ?? ""
  );

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    localStorage.setItem(ALERT_LEAD_KEY, String(alertLeadMins));
  }, [alertLeadMins]);

  useEffect(() => {
    const fetchStats = () =>
      fetch(`${BASE_URL}api/bot/analysis`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.bySession) setSessionStats(d.bySession); })
        .catch(() => {});
    fetchStats();
    const id = setInterval(fetchStats, 60_000);
    return () => clearInterval(id);
  }, []);

  const utcH    = now.getUTCHours();
  const utcM    = now.getUTCMinutes();
  const utcS    = now.getUTCSeconds();
  const utcFrac = utcH + utcM / 60 + utcS / 3600;

  const activeIdx   = SESSION_DEFS.findIndex(s => utcFrac >= s.start && utcFrac < s.end);
  const active      = activeIdx >= 0 ? SESSION_DEFS[activeIdx] : SESSION_DEFS[0];
  const nextIdx     = (activeIdx + 1) % SESSION_DEFS.length;
  const nextSession = SESSION_DEFS[nextIdx];
  const overlapIdx  = 3;

  const todayUTC = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;

  const fmtCountdown = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  };

  let secsToNext = Math.round((active.end - utcFrac) * 3600);
  if (secsToNext < 0) secsToNext += 86400;

  let secsToOverlap = Math.round((SESSION_DEFS[overlapIdx].start - utcFrac) * 3600);
  if (secsToOverlap < 0) secsToOverlap += 86400;
  const isOverlapActive = activeIdx === overlapIdx;

  const isImminent = !isOverlapActive && dismissedDate !== todayUTC && secsToOverlap <= alertLeadMins * 60;

  const dismissAlert = () => {
    localStorage.setItem(ALERT_DISMISSED_KEY, todayUTC);
    setDismissedDate(todayUTC);
  };

  const handleLeadSave = () => {
    if (leadSavingRef.current) return;
    leadSavingRef.current = true;
    const raw = leadInputRef.current?.value ?? leadInput;
    const v = parseInt(raw, 10);
    if (!isNaN(v) && v >= 1 && v <= 240) setAlertLeadMins(v);
    setEditingLead(false);
    setTimeout(() => { leadSavingRef.current = false; }, 100);
  };

  const UTC_TICKS = [0, 4, 8, 13, 16, 21, 24];

  const statFor = (name: string) => sessionStats.find(s => s.session === name) ?? null;

  return (
    <div style={{ marginTop: 10, width: "100%" }}>
      <div style={{ display: "flex", gap: 1, width: "100%", height: 22, borderRadius: 6, overflow: "hidden" }}>
        {SESSION_DEFS.map((s, i) => {
          const widthPct = ((s.end - s.start) / 24) * 100;
          const isActive = i === activeIdx;
          const stat = statFor(s.name);
          const tooltipPerfLine = stat && stat.count > 0
            ? `  |  ${stat.winRate.toFixed(0)}% W  avg ${stat.avgPnl >= 0 ? "+" : ""}${stat.avgPnl.toFixed(2)} USDT  (${stat.count} señales)`
            : "";
          return (
            <div
              key={s.name}
              title={`${s.name}  ${String(s.start).padStart(2,"0")}:00–${s.end === 24 ? "00" : String(s.end).padStart(2,"0")}:00 UTC  ×${s.defaultMult.toFixed(2)}${tooltipPerfLine}`}
              style={{
                flex: `0 0 ${widthPct}%`,
                background: isActive ? s.color : `${s.color}22`,
                border: isActive ? `1px solid ${s.color}` : `1px solid ${s.color}18`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 7, fontWeight: isActive ? 800 : 500,
                color: isActive ? (s.name === "London+NY Overlap" ? "#003d35" : "#fff") : `${s.color}70`,
                fontFamily: "var(--app-font-mono)",
                overflow: "hidden", whiteSpace: "nowrap",
                cursor: "default",
                transition: "all 0.3s",
              }}
            >
              {widthPct > 16 ? (s.name === "London+NY Overlap" ? "L+NY" : s.abbr.split(" ")[0]) : ""}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2, paddingLeft: 0 }}>
        {UTC_TICKS.map((h) => (
          <div key={h} style={{ fontSize: 8, color: "#374151", fontFamily: "var(--app-font-mono)" }}>
            {h === 24 ? "00" : String(h).padStart(2, "0")}h
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 1, marginTop: 4, width: "100%" }}>
        {SESSION_DEFS.map((s, i) => {
          const widthPct = ((s.end - s.start) / 24) * 100;
          const isActive = i === activeIdx;
          const stat = statFor(s.name);
          const hasData = stat && stat.count > 0;
          const winRateColor = hasData
            ? stat!.winRate >= 55 ? "#22c55e" : stat!.winRate >= 45 ? "#facc15" : "#f87171"
            : undefined;
          return (
            <div
              key={s.name}
              style={{
                flex: `0 0 ${widthPct}%`,
                display: "flex", flexDirection: "column", alignItems: "center",
                padding: "2px 0",
                borderRadius: 4,
                background: isActive ? `${s.color}12` : "transparent",
                overflow: "hidden",
              }}
            >
              <div style={{
                fontSize: 8, fontWeight: 700, letterSpacing: "0.04em",
                fontFamily: "var(--app-font-mono)",
                color: isActive ? s.color : `${s.color}55`,
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}>
                ×{s.defaultMult.toFixed(2)}
              </div>
              {hasData && (
                <div style={{
                  fontSize: 7, fontWeight: 600,
                  fontFamily: "var(--app-font-mono)",
                  color: winRateColor,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  opacity: isActive ? 1 : 0.65,
                  lineHeight: 1.2,
                }}>
                  {stat!.winRate.toFixed(0)}%W
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10 }}>
          <span style={{ color: "#5a6785" }}>Próxima ({nextSession.name}):</span>
          <span style={{
            color: "#c8d3e0", fontFamily: "var(--app-font-mono)", fontWeight: 700, fontSize: 11,
            background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)",
            padding: "1px 7px", borderRadius: 10,
          }}>{fmtCountdown(secsToNext)}</span>
        </div>
        {isOverlapActive ? (
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10 }}>
            <span style={{ fontSize: 8 }}>★</span>
            <span style={{ color: "#00D4AA", fontWeight: 700 }}>Ventana élite activa ahora</span>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10 }}>
            <span style={{ color: "#5a6785" }}>London+NY Overlap:</span>
            <span style={{
              color: "#00D4AA", fontFamily: "var(--app-font-mono)", fontWeight: 700, fontSize: 11,
              background: "rgba(0,212,170,0.08)", border: "1px solid rgba(0,212,170,0.25)",
              padding: "1px 7px", borderRadius: 10,
            }}>{fmtCountdown(secsToOverlap)}</span>
          </div>
        )}
      </div>

      {isImminent && (
        <div style={{
          marginTop: 10,
          display: "flex", alignItems: "center", gap: 10,
          padding: "8px 12px",
          borderRadius: 10,
          background: "rgba(0,212,170,0.10)",
          border: "1px solid rgba(0,212,170,0.40)",
          animation: "lnny-pulse 1.6s ease-in-out infinite",
        }}>
          <style>{`
            @keyframes lnny-pulse {
              0%, 100% { box-shadow: 0 0 0 0 rgba(0,212,170,0.30); }
              50%       { box-shadow: 0 0 0 6px rgba(0,212,170,0); }
            }
          `}</style>
          <span style={{ fontSize: 14 }}>⚡</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#00D4AA" }}>
              Ventana élite en {fmtCountdown(secsToOverlap)}
            </div>
            <div style={{ fontSize: 9, color: "#5a6785", marginTop: 1 }}>
              London+NY Overlap abre pronto — prepárate
            </div>
          </div>
          <button
            onClick={dismissAlert}
            title="Descartar alerta de hoy"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "#5a6785", fontSize: 13, lineHeight: 1, padding: "2px 4px",
              borderRadius: 4,
            }}
          >✕</button>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
        <span style={{ fontSize: 9, color: "#5a6785" }}>Alerta ventana élite:</span>
        {editingLead ? (
          <input
            ref={leadInputRef}
            autoFocus
            type="number"
            min={1}
            max={240}
            value={leadInput}
            onChange={e => setLeadInput(e.target.value)}
            onBlur={handleLeadSave}
            onKeyDown={e => { if (e.key === "Enter") handleLeadSave(); if (e.key === "Escape") setEditingLead(false); }}
            style={{
              width: 48, fontSize: 9, fontFamily: "var(--app-font-mono)",
              background: "rgba(255,255,255,0.07)", border: "1px solid rgba(0,212,170,0.4)",
              borderRadius: 5, color: "#c8d3e0", padding: "1px 5px", outline: "none",
            }}
          />
        ) : (
          <button
            onClick={() => { setLeadInput(String(alertLeadMins)); setEditingLead(true); }}
            title="Cambiar anticipación de la alerta"
            style={{
              background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8, cursor: "pointer", color: "#00D4AA",
              fontSize: 9, fontFamily: "var(--app-font-mono)", fontWeight: 700,
              padding: "1px 7px",
            }}
          >{alertLeadMins} min</button>
        )}
        <span style={{ fontSize: 9, color: "#5a6785" }}>antes</span>
        {dismissedDate === todayUTC && !isOverlapActive && (
          <button
            onClick={() => { localStorage.removeItem(ALERT_DISMISSED_KEY); setDismissedDate(""); }}
            title="Reactivar alerta para hoy"
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 8, color: "#5a6785", padding: 0,
              textDecoration: "underline",
            }}
          >restablecer</button>
        )}
      </div>
    </div>
  );
}

function MarketSessionBadge({ session, threshold }: { session?: { name: string; multiplier: number; thresholdBase?: number; thresholdAdjusted?: number }; threshold: number }) {
  const name          = session?.name ?? "—";
  const mult          = session?.multiplier ?? 1.00;
  const displayThresh = session?.thresholdAdjusted ?? threshold;
  const hours         = SESSION_HOURS[name];
  const displayName   = hours ? `${name} ${hours} UTC` : name;
  const multCol      = sessionMultColor(mult);
  const sessionColor  = multCol;
  const sessionBg     = multCol === "#00D4AA" ? "rgba(0,212,170,0.08)" : multCol === "#FF9500" ? "rgba(255,149,0,0.08)" : "rgba(242,54,69,0.08)";
  const sessionBorder = multCol === "#00D4AA" ? "rgba(0,212,170,0.25)" : multCol === "#FF9500" ? "rgba(255,149,0,0.25)" : "rgba(242,54,69,0.25)";
  const multBg       = multCol === "#00D4AA" ? "rgba(0,212,170,0.10)" : multCol === "#FF9500" ? "rgba(255,149,0,0.10)" : "rgba(242,54,69,0.10)";
  const multBorder   = multCol === "#00D4AA" ? "rgba(0,212,170,0.30)" : multCol === "#FF9500" ? "rgba(255,149,0,0.30)" : "rgba(242,54,69,0.30)";

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 0,
      padding: "10px 14px",
      borderRadius: 10,
      background: "rgba(255,255,255,0.025)",
      border: "1px solid rgba(255,255,255,0.06)",
    }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 10, color: "#5a6785", fontWeight: 700, letterSpacing: "0.08em" }}>
          SESIÓN UTC
        </div>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "3px 12px", borderRadius: 20,
          fontSize: 11, fontWeight: 700,
          background: sessionBg,
          border: `1px solid ${sessionBorder}`,
          color: sessionColor,
        }}>
          <span style={{ fontSize: 9 }}>●</span>
          {displayName}
        </div>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "3px 10px", borderRadius: 20,
          fontSize: 12, fontWeight: 700,
          background: multBg,
          border: `1px solid ${multBorder}`,
          color: multCol,
          fontFamily: "var(--app-font-mono)",
        }}>
          ×{mult.toFixed(2)}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 10, color: "#5a6785" }}>umbral ajustado</div>
          <div style={{
            padding: "3px 12px", borderRadius: 20,
            fontSize: 12, fontWeight: 700,
            fontFamily: "var(--app-font-mono)",
            background: "rgba(167,139,250,0.10)",
            border: "1px solid rgba(167,139,250,0.25)",
            color: "#A78BFA",
          }}>
            {displayThresh}
          </div>
        </div>
      </div>
      <SessionTimeline />
    </div>
  );
}

function GuardStatusRow({ escalonThreshold }: { escalonThreshold?: number }) {
  const [guards, setGuards] = useState<any>(null);
  const [topScore, setTopScore] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/tanit-reasoning`);
        if (r.ok && !cancelled) {
          const d = await r.json();
          setGuards(d.guards ?? null);
          const decisions: any[] = d.decisions ?? [];
          if (decisions.length > 0) {
            const max = Math.max(...decisions.map((dec: any) => dec.finalScore ?? 0));
            setTopScore(Math.round(max * 10) / 10);
          } else {
            setTopScore(null);
          }
        }
      } catch {}
    };
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!guards) return null;

  const btcOk     = !guards.btcFreeFall;
  const drawOk    = !guards.drawdownActive;
  const macroOk   = !guards.macroDangerZone;
  const fundingOk = !guards.frLongBlocked;
  const threshold  = escalonThreshold ?? 68;
  const scoreOk   = topScore !== null && topScore >= threshold;

  const chip = (label: string, ok: boolean, detail?: string) => (
    <div key={label} title={detail} style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 20,
      fontSize: 11, fontWeight: 600,
      background: ok ? "rgba(0,229,204,0.08)" : "rgba(242,54,69,0.10)",
      border: `1px solid ${ok ? "rgba(0,229,204,0.25)" : "rgba(242,54,69,0.30)"}`,
      color: ok ? "#00E5CC" : "#F23645",
    }}>
      <span style={{ fontSize: 9 }}>●</span>
      {label}
    </div>
  );

  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 6,
      padding: "10px 14px",
      borderRadius: 10,
      background: "rgba(255,255,255,0.025)",
      border: "1px solid rgba(255,255,255,0.06)",
    }}>
      <div style={{ fontSize: 10, color: "#5a6785", fontWeight: 700, letterSpacing: "0.08em", alignSelf: "center", marginRight: 4 }}>
        GUARDIAS
      </div>
      {chip("BTC", btcOk, btcOk ? "BTC estable" : `BTC caída libre (-${guards.btcDropPct?.toFixed(2)}%)`)}
      {chip("DRAWDOWN", drawOk, drawOk ? "Sin drawdown activo" : `Protección activa (+${guards.drawdownBonus}pts al umbral)`)}
      {chip(
        `FUNDING ${guards.frCurrentPct?.toFixed(4) ?? "?"}%`,
        fundingOk,
        fundingOk
          ? `Funding BTC ${guards.frCurrentPct?.toFixed(4) ?? "?"}% ≤ límite ${guards.frLongBlock}% — LONGs permitidos`
          : `Funding BTC ${guards.frCurrentPct?.toFixed(4) ?? "?"}% > límite ${guards.frLongBlock}% — LONGs bloqueados`
      )}
      {chip("MACRO", macroOk, macroOk ? "Sin eventos macro de alto impacto activos" : "Zona de peligro macro — evento USD próximo o reciente")}
      {topScore !== null && chip(
        `SEÑAL ${topScore}/${threshold}`,
        scoreOk,
        scoreOk ? `Score máximo ${topScore} supera umbral ${threshold}` : `Score máximo ${topScore} < umbral ${threshold}`
      )}
      <div style={{
        marginLeft: "auto", fontSize: 10, color: "#5a6785", alignSelf: "center",
        fontFamily: "var(--app-font-mono)",
      }}>
        umbral actual: {threshold}
      </div>
    </div>
  );
}

// ── Balance Bar estilo Bybit ─────────────────────────────────────────────────
function BybitBalanceBar({ eng }: { eng: any }) {
  const total    = eng.liveBalance   as number | undefined;
  const avail    = eng.liveAvailable as number | undefined;
  const inUse    = (total != null && avail != null) ? Math.max(0, total - avail) : undefined;
  const pct      = (total && inUse != null && total > 0) ? (inUse / total) * 100 : 0;
  const posCount = eng.positionCount as number ?? 0;

  const fmt = (n: number | undefined) => n != null ? "$" + n.toFixed(2) : "--";

  return (
    <div style={{
      background: "linear-gradient(135deg, #060f1a 0%, #081420 100%)",
      border: "1px solid rgba(0,212,170,0.12)",
      borderRadius: 14,
      padding: "16px 20px",
      display: "flex",
      flexDirection: "column",
      gap: 12,
    }}>
      {/* Top row: label + position count */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 7, height: 7, borderRadius: "50%",
            background: "#00D4AA",
            boxShadow: "0 0 8px #00D4AA88",
          }} />
          <span style={{
            fontFamily: "var(--app-font-mono)", fontSize: 9,
            letterSpacing: "0.18em", textTransform: "uppercase",
            color: "#5a7080", fontWeight: 700,
          }}>Cuenta Bybit — USDT Perpetuo</span>
        </div>
        <span style={{
          fontFamily: "var(--app-font-mono)", fontSize: 9,
          letterSpacing: "0.12em", textTransform: "uppercase",
          color: posCount > 0 ? "#00D4AA" : "#5a7080",
          background: posCount > 0 ? "rgba(0,212,170,0.08)" : "rgba(90,112,128,0.08)",
          border: `1px solid ${posCount > 0 ? "rgba(0,212,170,0.20)" : "rgba(90,112,128,0.15)"}`,
          padding: "2px 10px", borderRadius: 20,
        }}>
          {posCount} posición{posCount !== 1 ? "es" : ""} abiert{posCount !== 1 ? "as" : "a"}
        </span>
      </div>

      {/* Three metric columns */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0 }}>
        {/* Activos Totales */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{
            fontFamily: "var(--app-font-mono)", fontSize: 9,
            letterSpacing: "0.14em", textTransform: "uppercase", color: "#5a7080",
          }}>Activos Totales</span>
          <span style={{
            fontFamily: "var(--app-font-sans)", fontWeight: 800, fontSize: 22,
            color: "#ffffff", letterSpacing: "-0.5px",
          }}>{fmt(total)}</span>
          <span style={{ fontSize: 10, color: "#5a7080" }}>USDT</span>
        </div>

        {/* Disponible */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, borderLeft: "1px solid rgba(255,255,255,0.06)", paddingLeft: 20 }}>
          <span style={{
            fontFamily: "var(--app-font-mono)", fontSize: 9,
            letterSpacing: "0.14em", textTransform: "uppercase", color: "#5a7080",
          }}>Disponible</span>
          <span style={{
            fontFamily: "var(--app-font-sans)", fontWeight: 800, fontSize: 22,
            color: "#00D4AA", letterSpacing: "-0.5px",
          }}>{fmt(avail)}</span>
          <span style={{ fontSize: 10, color: "#5a7080" }}>Libre para operar</span>
        </div>

        {/* En Uso */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, borderLeft: "1px solid rgba(255,255,255,0.06)", paddingLeft: 20 }}>
          <span style={{
            fontFamily: "var(--app-font-mono)", fontSize: 9,
            letterSpacing: "0.14em", textTransform: "uppercase", color: "#5a7080",
          }}>En Uso</span>
          <span style={{
            fontFamily: "var(--app-font-sans)", fontWeight: 800, fontSize: 22,
            color: inUse && inUse > 0 ? "#FF9500" : "#5a7080", letterSpacing: "-0.5px",
          }}>{fmt(inUse)}</span>
          <span style={{ fontSize: 10, color: "#5a7080" }}>Margen activo</span>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: "#5a7080", letterSpacing: "0.1em" }}>
            CAPITAL DESPLEGADO
          </span>
          <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: pct > 60 ? "#FF9500" : "#00D4AA", fontWeight: 700 }}>
            {pct.toFixed(1)}%
          </span>
        </div>
        <div style={{
          height: 4, borderRadius: 4,
          background: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}>
          <div style={{
            height: "100%",
            width: `${Math.min(100, pct)}%`,
            borderRadius: 4,
            background: pct > 80 ? "#F23645" : pct > 50 ? "#FF9500" : "#00D4AA",
            transition: "width 0.6s ease, background 0.4s ease",
          }} />
        </div>
      </div>
    </div>
  );
}

export default function Bot() {
  const { data: botStatus, refetch: refetchBot } = useGetBotStatus({ query: { queryKey: ["bot-status"], refetchInterval: 4000 } });
  const { data: balance }  = useGetBalance({ query: { queryKey: ["balance"], refetchInterval: 10000 } });
  const { data: stats }    = useGetPortfolioStats({ query: { queryKey: ["portfolio-stats"], refetchInterval: 30000 } });
  const { data: trades }   = useGetTrades({ query: { queryKey: ["trades"], refetchInterval: 30000 } });

  const toggleBot = useToggleBot();

  const isRunning    = (botStatus as any)?.active ?? (botStatus as any)?.isRunning ?? false;
  const logs         = (botStatus as any)?.logs ?? [];
  const recentTrades = (trades ?? []).slice(0, 8);
  const hasStats     = stats && stats.totalTrades > 0;
  const hasBalance   = balance && balance.totalEquity > 0;

  // ── Session data from engine status ─────────────────────────────────────
  const eng: any = (botStatus as any) ?? {};
  const sessionNum     = eng.sessionNumber ?? 0;
  const sessionPnl     = eng.sessionPnlCurrent ?? 0;
  const sessionWins    = eng.sessionWins ?? 0;
  const sessionLosses  = eng.sessionLosses ?? 0;
  const sessionTrades  = eng.sessionTradesCurrent ?? 0;
  const isInBreak        = eng.isInBreak ?? false;
  const breakRemainingMs = eng.breakRemainingMs ?? 0;
  const remainingMs      = eng.sessionRemainingMs ?? 0;
  const sessionHistory: any[] = eng.sessionHistory ?? [];
  const signalInverted   = eng.signalInverted ?? false;
  const btcMacroBear     = eng.btcMacro1hBear ?? false;
  const btcMacroBull     = eng.btcMacro1hBull ?? false;
  const consecutiveLosses = eng.consecutiveLosses ?? 0;
  const escalonThreshold = eng.escalonThreshold ?? 68;
  const marketSession: { name: string; multiplier: number; thresholdBase?: number; thresholdAdjusted?: number } | undefined = eng.marketSession;

  // ── Scale-in notifications — poll and inject into chat ──────────────────
  const [scaleInNotifications, setScaleInNotifications] = useState<ScaleInNotification[]>([]);
  const seenScaleInRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch(`${BASE_URL}api/bot/scale-in-events?limit=5`);
        if (!r.ok) return;
        const d = await r.json();
        const events: any[] = d.events ?? [];
        const fresh = events.filter((e: any) => !seenScaleInRef.current.has(e.ts));
        if (fresh.length === 0) return;
        fresh.forEach((e: any) => seenScaleInRef.current.add(e.ts));
        const notifs: ScaleInNotification[] = fresh.map((e: any) => {
          const sym = (e.symbol ?? "").replace("USDT", "");
          return {
            key: e.ts,
            text: `🚀 SCALE-IN ejecutado — ${sym} ${e.direction} +${e.qty} @ ${parseFloat(e.price).toFixed(4)} (momentum explosivo · nueva entrada promedio: ${parseFloat(e.newEntryAvg).toFixed(4)})`,
          };
        });
        setScaleInNotifications(prev => [...prev, ...notifs]);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  // ── Top-level tab: Operativa | Aprendizaje ──────────────────────────────
  const [activeTab, setActiveTab] = useState<"operativa" | "aprendizaje">("operativa");

  // ── Swap history backed by DB (survives restarts) ───────────────────────
  const PAGE_SIZE = 50;
  const [dbSwapHistory, setDbSwapHistory] = useState<SwapEvent[]>([]);
  const [hasMoreSwaps, setHasMoreSwaps]   = useState(false);
  const [loadingMoreSwaps, setLoadingMoreSwaps] = useState(false);
  // Keep a ref so the interval callback always sees the latest loaded length
  const dbSwapHistoryLenRef = useRef(0);
  useEffect(() => { dbSwapHistoryLenRef.current = dbSwapHistory.length; }, [dbSwapHistory.length]);

  useEffect(() => {
    const fetchSwaps = async () => {
      try {
        // Re-fetch as many rows as currently shown (preserves expanded history)
        const currentLen = dbSwapHistoryLenRef.current;
        const limit = Math.max(PAGE_SIZE, currentLen);
        const r = await fetch(`${BASE_URL}api/bot/swaps?limit=${limit}&offset=0`);
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data.swaps)) {
            setDbSwapHistory(data.swaps);
            setHasMoreSwaps(data.swaps.length === limit);
          }
        }
      } catch { /* ignore */ }
    };
    fetchSwaps();
    const id = setInterval(fetchSwaps, 30000);
    return () => clearInterval(id);
  }, []);

  const loadMoreSwaps = async () => {
    if (loadingMoreSwaps) return;
    setLoadingMoreSwaps(true);
    try {
      const offset = dbSwapHistory.length;
      const r = await fetch(`${BASE_URL}api/bot/swaps?limit=${PAGE_SIZE}&offset=${offset}`);
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data.swaps) && data.swaps.length > 0) {
          setDbSwapHistory(prev => [...prev, ...data.swaps]);
          setHasMoreSwaps(data.swaps.length === PAGE_SIZE);
        } else {
          setHasMoreSwaps(false);
        }
      }
    } catch { /* ignore */ } finally {
      setLoadingMoreSwaps(false);
    }
  };

  // ── Market session from signals ──────────────────────────────────────────
  const lastSignals: any = eng.lastSignals ?? {};
  const sessionNames = Object.values(lastSignals).map((s: any) => s?.sessionName).filter(Boolean);
  const currentSession = sessionNames[0] ?? null;

  const sessionQuality = (() => {
    if (!currentSession) return null;
    if (currentSession.includes("London+NY") || currentSession.includes("Overlap")) return "ELITE";
    if (currentSession.includes("London") || currentSession.includes("NY Peak")) return "HIGH";
    if (currentSession.includes("Dead")) return "DEAD";
    return "MEDIUM";
  })();

  const handleToggle = () => {
    toggleBot.mutate(
      { data: { active: !isRunning } },
      { onSuccess: () => refetchBot() }
    );
  };

  // ── Modo Solo Plática ────────────────────────────────────────────────────
  const [chatOnlyMode, setChatOnlyMode] = useState<boolean | null>(null);
  const [chatOnlyLoading, setChatOnlyLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch(`${BASE_URL}admin/chat-only-mode`);
        if (r.ok) {
          const d = await r.json();
          setChatOnlyMode(d.chat_only_mode ?? false);
        }
      } catch {}
    };
    load();
  }, []);

  const toggleChatOnly = async () => {
    if (chatOnlyLoading) return;
    setChatOnlyLoading(true);
    try {
      const next = !chatOnlyMode;
      const r = await fetch(`${BASE_URL}admin/chat-only-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      if (r.ok) setChatOnlyMode(next);
    } catch {} finally {
      setChatOnlyLoading(false);
    }
  };

  return (
    <Layout>
      <div className="space-y-5 max-w-5xl" style={{ paddingBottom: 110 }}>

        {/* ── Header ── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Algorithmic Bot</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Fibonacci + Whale Hours + Gemini AI — motor autónomo de señales.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {currentSession && (
              <div className="px-2.5 py-1 rounded-full text-[10px] font-bold border"
                style={{
                  borderColor: (SESSION_QUALITY_COLOR[sessionQuality ?? "MEDIUM"]) + "40",
                  background:  (SESSION_QUALITY_COLOR[sessionQuality ?? "MEDIUM"]) + "10",
                  color:        SESSION_QUALITY_COLOR[sessionQuality ?? "MEDIUM"],
                }}>
                {currentSession}
              </div>
            )}
            <button
            onClick={toggleChatOnly}
            disabled={chatOnlyLoading || chatOnlyMode === null}
            title={chatOnlyMode ? "Salir de modo solo plática" : "Activar modo solo plática — pausa loops y bloquea Opus"}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "6px 12px", borderRadius: 999,
              fontSize: 11, fontWeight: 700, fontFamily: "var(--app-font-mono)",
              letterSpacing: "0.06em", cursor: chatOnlyLoading ? "wait" : "pointer",
              transition: "all 0.15s",
              border: `1px solid ${chatOnlyMode ? "rgba(167,139,250,0.45)" : "rgba(138,152,179,0.25)"}`,
              background: chatOnlyMode ? "rgba(167,139,250,0.12)" : "rgba(138,152,179,0.06)",
              color: chatOnlyMode ? "#A78BFA" : "#6a7890",
              opacity: chatOnlyMode === null ? 0.4 : 1,
            }}
          >
            <span>{chatOnlyMode ? "💬" : "🔇"}</span>
            {chatOnlyLoading ? "..." : chatOnlyMode ? "SOLO PLÁTICA" : "SOLO PLÁTICA"}
          </button>

          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border ${
              isRunning
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border bg-muted/20 text-muted-foreground"
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-primary animate-pulse" : "bg-muted-foreground/50"}`} />
              {isRunning ? (isInBreak ? "Descanso" : "Activo") : "Offline"}
            </div>
          </div>
        </div>

        {/* ── Banner modo solo plática ── */}
        {chatOnlyMode && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "10px 16px", borderRadius: 12,
            background: "rgba(167,139,250,0.08)",
            border: "1px solid rgba(167,139,250,0.25)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 16 }}>💬</span>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#A78BFA", fontFamily: "var(--app-font-mono)", letterSpacing: "0.08em" }}>
                  MODO SOLO PLÁTICA ACTIVO
                </div>
                <div style={{ fontSize: 10, color: "#6a7890", marginTop: 2 }}>
                  Live loop muteado · Autonomous loop pausado · Opus bloqueado
                </div>
              </div>
            </div>
            <button
              onClick={toggleChatOnly}
              disabled={chatOnlyLoading}
              style={{
                fontSize: 10, fontWeight: 700, fontFamily: "var(--app-font-mono)",
                padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                background: "rgba(167,139,250,0.15)", color: "#A78BFA",
                border: "1px solid rgba(167,139,250,0.30)",
              }}
            >
              {chatOnlyLoading ? "..." : "DESACTIVAR"}
            </button>
          </div>
        )}

        {/* ── TAB SWITCHER — Operativa | Aprendizaje ── */}
        <div className="flex items-center gap-2 border-b border-border/40">
          {[
            { id: "operativa", label: "Operativa", color: GREEN },
            { id: "aprendizaje", label: "Aprendizaje", color: "#A78BFA" },
          ].map(t => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id as "operativa" | "aprendizaje")}
                style={{
                  padding: "10px 18px",
                  fontFamily: "var(--app-font-mono)",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: active ? t.color : "#6a7890",
                  background: active ? t.color + "10" : "transparent",
                  border: "none",
                  borderBottom: `2px solid ${active ? t.color : "transparent"}`,
                  marginBottom: -1,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {activeTab === "aprendizaje" ? (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold text-[#A78BFA] uppercase tracking-widest">
              Aprendizaje Autónomo
            </h2>
            <p className="text-[11px] text-muted-foreground">
              Umbrales por sesión, símbolos preferidos/evitados, ciclos de evolución y estado de drawdown.
            </p>
            <TanitLearning status={(botStatus as TanitLearningData | null) ?? null} apiBase={BASE_URL.replace(/\/$/, "")} />
          </div>
        ) : (
          <>
        {/* ── BALANCE REAL BYBIT ── */}
        <BybitBalanceBar eng={eng} />

        {/* ── POSICIONES REALES BYBIT — siempre visible ── */}
        <RealBybitPositions />

        {/* ── SESIÓN DE MERCADO Y UMBRAL AJUSTADO ── */}
        <MarketSessionBadge session={marketSession} threshold={escalonThreshold} />

        {/* ── GUARDIAS DE PROTECCIÓN — estado en tiempo real ── */}
        {isRunning && <GuardStatusRow escalonThreshold={escalonThreshold} />}

        {/* ── PARÁMETROS EN VIVO FASE 4 ── */}
        <TanitParamsPanel />

        {/* ── Stats / Momento Cero ── */}
        {!hasBalance && !hasStats ? (
          <div className="card-glass p-6 flex flex-col items-center text-center gap-3">
            <div className="w-12 h-12 rounded-full flex items-center justify-center mb-1"
              style={{ background: "rgba(0,212,170,0.08)", border: "1px solid rgba(0,212,170,0.15)" }}>
              <span style={{ color: GREEN, fontSize: 22 }}>◎</span>
            </div>
            <div className="font-bold text-foreground text-base">Punto de partida</div>
            <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">
              Aún no hay operaciones registradas. Selecciona un modo de riesgo e inicia el bot para ver tus primeras estadísticas aquí.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Capital Total"
              value={hasBalance ? "$" + balance!.totalEquity.toFixed(2) : "--"}
              sub="USDT en Bybit" />
            <StatCard label="Win Rate"
              value={hasStats ? stats!.winRate + "%" : "—"}
              color={hasStats && stats!.winRate > 55 ? GREEN : hasStats ? RED : undefined}
              sub={hasStats ? `${stats!.totalTrades} trades` : "sin datos aún"} />
            <StatCard label="PnL Total"
              value={hasStats ? (stats!.totalPnl >= 0 ? "+" : "") + "$" + stats!.totalPnl.toFixed(2) : "—"}
              color={hasStats ? (stats!.totalPnl >= 0 ? GREEN : RED) : undefined} />
            <StatCard label="Racha"
              value={hasStats && stats!.currentStreak > 0 ? "+" + stats!.currentStreak : "—"}
              color={hasStats && stats!.currentStreak > 0 ? GREEN : undefined}
              sub="consecutivos" />
          </div>
        )}

        {/* ── PANEL DE SESIÓN — solo visible cuando el bot está activo ── */}
        {isRunning && (
          <div className="card-glass p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-bold text-sm text-foreground">
                  {isInBreak ? "Descanso entre sesiones" : `Sesión ${sessionNum}`}
                </h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {isInBreak
                    ? "Cerrando posiciones, limpiando caché, preparando análisis fresco..."
                    : "Cada sesión dura 30 min. Al terminar, el bot descansa 90 seg y re-analiza el mercado desde cero."}
                </p>
              </div>
              {sessionNum > 0 && (
                <div className="text-right shrink-0">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-widest">PnL sesión</div>
                  <div className="font-mono font-bold text-base" style={{ color: sessionPnl >= 0 ? GREEN : RED }}>
                    {sessionPnl >= 0 ? "+" : ""}${sessionPnl.toFixed(2)}
                  </div>
                </div>
              )}
            </div>

            <SessionTimer remainingMs={remainingMs} isInBreak={isInBreak} breakRemainingMs={breakRemainingMs} />

            {/* ── INDICADORES DE RÉGIMEN ── */}
            {(signalInverted || btcMacroBear || btcMacroBull) && (
              <div className="flex flex-col gap-2 mt-3">
                {signalInverted && (
                  <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-mono font-bold"
                    style={{ background: "rgba(255,149,0,0.12)", border: "1px solid rgba(255,149,0,0.35)", color: "#FF9500" }}>
                    AUTO-INVERSION ACTIVA — {consecutiveLosses} pérdidas seguidas.
                    Direcciones invertidas (LONG→SHORT, SHORT→LONG)
                  </div>
                )}
                {btcMacroBear && !signalInverted && (
                  <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-mono"
                    style={{ background: "rgba(242,54,69,0.1)", border: "1px solid rgba(242,54,69,0.25)", color: "#F23645" }}>
                    BTC MACRO BAJISTA — señales LONG penalizadas -20pts
                  </div>
                )}
                {btcMacroBull && !signalInverted && (
                  <div className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-mono"
                    style={{ background: "rgba(0,212,170,0.1)", border: "1px solid rgba(0,212,170,0.25)", color: "#00D4AA" }}>
                    BTC MACRO ALCISTA — sesgo LONG +8pts en altcoins
                  </div>
                )}
              </div>
            )}

            {sessionTrades > 0 && (
              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className="bg-muted/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Trades</div>
                  <div className="font-mono font-bold text-foreground">{sessionTrades}</div>
                </div>
                <div className="bg-muted/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Wins</div>
                  <div className="font-mono font-bold" style={{ color: GREEN }}>{sessionWins}</div>
                </div>
                <div className="bg-muted/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Losses</div>
                  <div className="font-mono font-bold" style={{ color: RED }}>{sessionLosses}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── HISTORIAL DE SESIONES ── */}
        {sessionHistory.length > 0 && (
          <div className="card-glass p-5">
            <h2 className="font-bold text-sm text-foreground mb-1">Historial de Sesiones</h2>
            <p className="text-[11px] text-muted-foreground mb-3">
              Cada sesión opera 30 min y descansa 90 seg antes de la siguiente.
            </p>
            <div className="space-y-2">
              {sessionHistory.slice(0, 5).map((s: any) => {
                const winRate = s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0;
                return (
                  <div key={s.number} className="flex items-center justify-between bg-muted/20 rounded-xl px-4 py-2.5 text-xs">
                    <div className="flex items-center gap-3">
                      <div className="font-mono text-muted-foreground/60">#{s.number}</div>
                      <div className="text-muted-foreground">{s.trades} trades</div>
                      <div className="font-mono" style={{ color: winRate >= 50 ? GREEN : RED }}>{winRate}% win</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-muted-foreground/50 text-[10px]">{s.durationMin}min</div>
                      <div className="font-mono font-bold" style={{ color: s.pnl >= 0 ? GREEN : RED }}>
                        {s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(2)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── FIBONACCI + SESIÓN DE MERCADO — explicación ── */}
        <div className="card-glass p-5">
          <h2 className="font-bold text-sm text-foreground mb-1">Motor Fibonacci + Horario de Ballenas</h2>
          <p className="text-[11px] text-muted-foreground mb-4">
            5 ideas cuantitativas para entrar exactamente donde el institucional actúa.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            {[
              { n: "Fib 1", title: "Retroceso Áureo 61.8%", desc: "Entrada en el Golden Ratio — donde las ballenas re-acumulan en uptrends. +20 pts al score.", color: GREEN },
              { n: "Fib 2", title: "TP por Extensión 1.272–1.618", desc: "Take profit exacto en extensión Fibonacci. Más preciso que %. El mercado respeta estos niveles.", color: GREEN },
              { n: "Fib 3", title: "Confluencia Fibonacci", desc: "Dos swings distintos convergen en el mismo nivel. Alta probabilidad institucional. +18 pts.", color: AMBER },
              { n: "Fib 4", title: "Fib + Divergencia RSI", desc: "Precio en nivel Fib + RSI divergente = acumulación silenciosa institucional. +15 pts elite.", color: AMBER },
              { n: "Fib 5", title: "Horario Ballenas UTC", desc: "London+NY Overlap (13-16h UTC): +12 pts. Dead Zone (22-02h UTC): -10 pts y convicción -50%.", color: GREEN },
            ].map(({ n, title, desc, color }) => (
              <div key={n} className="bg-muted/20 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded"
                    style={{ background: color + "15", color }}>
                    {n}
                  </div>
                  <div className="font-semibold text-sm text-foreground">{title}</div>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
            {/* Sesiones de mercado */}
            <div className="bg-muted/20 rounded-xl p-4">
              <div className="text-[10px] font-bold mb-2 text-muted-foreground uppercase tracking-widest">Calidad de sesión UTC</div>
              <div className="space-y-1.5">
                {[
                  { label: "13-16h  London+NY Overlap", quality: "ELITE", pts: "+12" },
                  { label: "08-13h  London Session",     quality: "HIGH",  pts: "+7"  },
                  { label: "16-20h  NY Peak",            quality: "HIGH",  pts: "+7"  },
                  { label: "02-06h  Asia Session",       quality: "LOW",   pts: "-3"  },
                  { label: "22-02h  Dead Zone",          quality: "DEAD",  pts: "-10" },
                ].map(({ label, quality, pts }) => (
                  <div key={label} className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold" style={{ color: SESSION_QUALITY_COLOR[quality] }}>{pts}</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                        style={{ background: SESSION_QUALITY_COLOR[quality] + "15", color: SESSION_QUALITY_COLOR[quality] }}>
                        {quality}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── MAPA HORARIO DE BALLENAS ── */}
        <WhalePatternMap />

        {/* ── Estrategia Escalon ── */}
        <div className="card-glass p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="font-bold text-sm text-foreground">Estrategia Escalon</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                3 monedas alineadas (score ≥74) → entrada escalonada con apalancamientos y capital ponderado.
              </p>
            </div>
            <div className="text-[10px] font-mono px-2 py-1 rounded"
              style={{ background: GREEN + "10", color: GREEN, border: `1px solid ${GREEN}20` }}>
              10/25/50x
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {ESCALON_TIERS.map(tier => (
              <div key={tier.label} className="bg-muted/20 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-bold text-sm" style={{ color: tier.color }}>{tier.label}</div>
                  <div className="font-mono text-xs font-bold text-foreground">{tier.leverage}x</div>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed mb-3">{tier.desc}</p>
                <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                  {[
                    ["Capital", tier.weight + "%"],
                    ["SL",      tier.sl],
                    ["TP",      tier.tp],
                  ].map(([lbl, val]) => (
                    <div key={lbl} className="bg-muted/30 rounded-lg p-2 text-center">
                      <div className="text-[10px] text-muted-foreground">{lbl}</div>
                      <div className="font-mono font-bold text-foreground mt-0.5">{val}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-start gap-1.5 rounded-lg p-2.5"
            style={{ background: GREEN + "08", border: `1px solid ${GREEN}15` }}>
            <InfoIcon className="w-3 h-3 text-primary shrink-0 mt-0.5" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              BTC establece el sesgo macro. Las altcoins con señal dominante ≥74 se asignan a los tiers por convicción. Cooldown 4min tras pérdida. Auto-inversión tras 3 pérdidas seguidas.
            </p>
          </div>
        </div>

        {/* ── Bitácora + Trades ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card-glass p-5">
            <h2 className="font-bold text-sm text-foreground mb-1">Bitácora del Sistema</h2>
            <p className="text-[11px] text-muted-foreground mb-3">Registro en tiempo real de acciones del bot.</p>
            <div className="bg-muted/10 rounded-xl p-3 max-h-52 overflow-y-auto space-y-1.5">
              {logs.length > 0 ? logs.slice(-15).reverse().map((log: any, i: number) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  <span className="text-muted-foreground/40 font-mono shrink-0">
                    {new Date(log.timestamp).toLocaleTimeString("es")}
                  </span>
                  <span className={log.level === "error" ? "text-red-400" : log.level === "warn" ? "text-amber-400" : "text-muted-foreground"}>
                    {log.message}
                  </span>
                </div>
              )) : (
                <div className="space-y-2">
                  {["Sistema listo", "Esperando señales...", "Inicia el bot para ver actividad"].map((t, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px]">
                      <ClockIcon className="w-3 h-3 text-muted-foreground/30 shrink-0" />
                      <span className="text-muted-foreground">{t}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card-glass p-5">
            <h2 className="font-bold text-sm text-foreground mb-1">Últimas Operaciones</h2>
            <p className="text-[11px] text-muted-foreground mb-3">Trades ejecutados por el bot.</p>
            {(() => {
              const engineLog: any[] = ((botStatus as any)?.tradeLog ?? []).slice(0, 8);
              const displayTrades = engineLog.length > 0 ? engineLog : recentTrades.slice(0, 8);
              if (displayTrades.length === 0) {
                return (
                  <div className="h-36 flex flex-col items-center justify-center gap-2 text-center rounded-xl"
                    style={{ border: "1px dashed hsl(var(--border))" }}>
                    <div className="text-muted-foreground/40 text-2xl">◎</div>
                    <p className="text-[12px] text-muted-foreground">
                      Las operaciones aparecerán aquí<br />en cuanto el bot ejecute la primera entrada.
                    </p>
                  </div>
                );
              }
              return (
                <div className="space-y-2">
                  {displayTrades.map((t: any, idx: number) => {
                    const isSwapClose = typeof t.reason === "string" && t.reason.startsWith("Swap");
                    const rawSide = t.side ?? (t.direction === "LONG" ? "Buy" : "Sell");
                    const isLong = rawSide === "Buy" || rawSide === "LONG";
                    const pnl = t.pnl ?? 0;
                    const sym = (t.symbol ?? "").replace("USDT", "");
                    return (
                      <div key={t.id ?? idx} className="flex items-center justify-between bg-muted/20 rounded-xl px-3 py-2 text-xs">
                        <div className="flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full" style={{ background: isLong ? GREEN : RED }} />
                          <span className="font-bold font-mono">{sym}</span>
                          <span className="text-muted-foreground">{isLong ? "Long" : "Short"}</span>
                          {isSwapClose && (
                            <span style={{
                              fontFamily: "var(--app-font-mono)", fontSize: 8, fontWeight: 700,
                              padding: "1px 5px", borderRadius: 3,
                              background: "rgba(255,149,0,0.15)", color: AMBER,
                              border: "1px solid rgba(255,149,0,0.3)",
                            }}>♻️ SWAP</span>
                          )}
                        </div>
                        <div className="font-mono font-bold" style={{ color: pnl >= 0 ? GREEN : RED }}>
                          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                        </div>
                        <div className="text-muted-foreground">{t.leverage}x</div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>
          </>
        )}
      </div>

      {activeTab === "operativa" && (
        <>
          {/* ── HISTORIAL DE SWAPS — datos persistidos en DB, sobreviven reinicios ── */}
          <SwapHistory
            swaps={dbSwapHistory.length > 0 ? dbSwapHistory : ((botStatus as any)?.swapHistory ?? [])}
            hasMore={dbSwapHistory.length > 0 ? hasMoreSwaps : false}
            loadingMore={loadingMoreSwaps}
            onLoadMore={loadMoreSwaps}
          />

          {/* ── SOBRE TANIT — identidad, fases de evolución, voz interior ── */}
          <div className="px-4 pb-4 space-y-2">
            <h2 className="text-xs font-semibold text-[#00E5CC] uppercase tracking-widest">
              Sobre Tanit
            </h2>
            <TanitIdentity />
          </div>

          {/* ── RAZONAMIENTO DE TANIT — decisiones ACCEPT/REJECT con desglose causal ── */}
          <div className="px-4 pb-4 space-y-2">
            <h2 className="text-xs font-semibold text-[#00E5CC] uppercase tracking-widest">
              Razonamiento de Tanit
            </h2>
            <TanitReasoning />
          </div>

          {/* ── SEGURIDAD TELEGRAM — intentos rechazados recientes ── */}
          <TelegramAuditPanel />
        </>
      )}

      {/* ── GEMINI COMMAND BAR — siempre visible en la parte inferior ── */}
      <GeminiCommandBar
        isRunning={isRunning}
        onToggle={handleToggle}
        togglePending={toggleBot.isPending}
        notifications={scaleInNotifications}
      />
    </Layout>
  );
}
