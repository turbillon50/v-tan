import { useState, useEffect, useCallback } from "react";
import { Layout } from "@/components/layout";
import { BASE_URL } from "@/lib/api";

// ── Paleta editorial (idéntica al panel) ─────────────────────────────────────
const TEAL  = "#0ECB81";
const RED   = "#F6465D";
const AMBER = "#F5A623";
const WHITE = "#FFFFFF";
const DIM   = "#7a8ba8";
const MID   = "#a8b6cc";
const SOFT  = "#c8d4e0";

const BG    = "#080c14";
const CARD  = "#0d1421";
const DEEP  = "#080c14";
const LINE  = "#1a2433";

const BG_WIN  = "#041a0f";
const BG_LOSS = "#160408";
const BDR_WIN = "#0a3020";
const BDR_LSS = "#2a0c0c";
const BG_AMB  = "#100a00";
const BDR_AMB = "#2a1800";

const SYM: Record<string,string> = {
  BTCUSDT:"BTC",ETHUSDT:"ETH",SOLUSDT:"SOL",
  BNBUSDT:"BNB",XRPUSDT:"XRP",DOGEUSDT:"DOGE",
};

function px(p?: number | string) {
  const n = Number(p);
  if (!p || isNaN(n)) return "—";
  if (n >= 1000) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1)    return "$" + n.toFixed(4);
  return "$" + n.toFixed(5);
}

function holdDur(mins?: number | string) {
  const m = Number(mins);
  if (!mins || isNaN(m) || m === 0) return "—";
  if (m < 60) return `${Math.round(m)}m`;
  return `${Math.floor(m/60)}h${m%60 ? `${Math.round(m%60)}m` : ""}`;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-MX", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function getBadge(status?: string): { label: string; bg: string; text: string } {
  if (status === "win")     return { label: "TP",   bg: TEAL,    text: "#020d09" };
  if (status === "loss")    return { label: "SL",   bg: RED,     text: WHITE };
  if (status === "stopped") return { label: "STOP", bg: DIM,     text: WHITE };
  return { label: "—", bg: "#222", text: WHITE };
}

const Label = ({ children, color = DIM }: { children: React.ReactNode; color?: string }) => (
  <div style={{
    fontFamily: "var(--app-font-mono, monospace)",
    fontSize: 9, letterSpacing: "0.18em",
    textTransform: "uppercase" as const,
    color, fontWeight: 500,
  }}>{children}</div>
);

type Trade = {
  id: number; symbol: string; direction: string;
  entry_price: string; exit_price: string;
  size: string; leverage: string; pnl: string;
  status: string; hold_minutes: string; computed_hold_min: string;
  open_at: string; close_at: string; daily_regime?: string;
};

function tradeLogToTrades(tl: any[]): Trade[] {
  return tl.map((t, i) => ({
    id: -(i + 1),
    symbol: t.symbol ?? "",
    direction: t.side ?? "",
    entry_price: String(t.entryPrice ?? ""),
    exit_price: String(t.exitPrice ?? ""),
    size: String(t.qty ?? ""),
    leverage: String(t.leverage ?? ""),
    pnl: String(t.pnl ?? 0),
    status: Number(t.pnl) >= 0 ? "win" : "loss",
    hold_minutes: String(t.holdMinutes ?? 0),
    computed_hold_min: String(t.holdMinutes ?? 0),
    open_at: t.openedAt ?? "",
    close_at: t.closedAt ?? "",
    daily_regime: t.reason ?? "",
  })).sort((a, b) => new Date(b.close_at).getTime() - new Date(a.close_at).getTime());
}

function summaryFromTrades(ts: Trade[]): Summary {
  const closed = ts.filter(t => t.status === "win" || t.status === "loss");
  const wins = closed.filter(t => t.status === "win").length;
  const losses = closed.filter(t => t.status === "loss").length;
  const totalPnl = closed.reduce((s, t) => s + Number(t.pnl), 0);
  return { total: closed.length, wins, losses, totalPnl, winRate: (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0 };
}

type Summary = {
  total: number; wins: number; losses: number;
  totalPnl: number; winRate: number;
};

const PAGE = 50;

export default function Historial() {
  const [trades, setTrades]     = useState<Trade[]>([]);
  const [summary, setSummary]   = useState<Summary | null>(null);
  const [loading, setLoading]   = useState(true);
  const [offset, setOffset]     = useState(0);
  const [total, setTotal]       = useState(0);
  const [filter, setFilter]     = useState<"all"|"win"|"loss">("all");
  const [showDelAll, setShowDelAll] = useState(false);
  const [showDelOld, setShowDelOld] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [msg, setMsg]           = useState("");
  const [botStatus, setBotStatus] = useState<any>(null);

  const load = useCallback(async (off = 0) => {
    setLoading(true);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);

      const [dbRes, statusRes] = await Promise.allSettled([
        fetch(`${BASE_URL}api/bot/trades/db?limit=${PAGE}&offset=${off}`, { signal: ctrl.signal }),
        fetch(`${BASE_URL}api/bot/status`, { signal: ctrl.signal }),
      ]);
      clearTimeout(timer);

      const dbData     = dbRes.status === "fulfilled" && dbRes.value.ok     ? await dbRes.value.json()     : null;
      const statusData = statusRes.status === "fulfilled" && statusRes.value.ok ? await statusRes.value.json() : null;
      if (statusData) setBotStatus(statusData);

      const dbTrades: Trade[]  = dbData?.trades ?? [];
      const tlRaw: any[]       = statusData?.tradeLog ?? [];

      if (dbTrades.length > 0) {
        setTrades(dbTrades);
        setTotal(dbData?.pagination?.total ?? dbTrades.length);
        setSummary(dbData?.summary ?? null);
      } else if (tlRaw.length > 0) {
        const converted = tradeLogToTrades(tlRaw);
        const paged = converted.slice(off, off + PAGE);
        setTrades(paged);
        setTotal(converted.length);
        setSummary(summaryFromTrades(converted));
      } else {
        setTrades([]);
        setTotal(0);
        setSummary(null);
      }
      setOffset(off);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(0); }, [load]);

  const clearAll = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${BASE_URL}api/bot/trades/clear`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setMsg(d.message ?? "Historial borrado");
      await load(0);
    } catch (e) { setMsg("Error: " + String(e)); }
    finally { setBusy(false); setShowDelAll(false); }
  };

  const clearOld = async () => {
    setBusy(true);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    try {
      const r = await fetch(`${BASE_URL}api/bot/trades/clear`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ before: cutoff.toISOString() }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setMsg(d.message ?? "Operaciones viejas eliminadas");
      await load(0);
    } catch (e) { setMsg("Error: " + String(e)); }
    finally { setBusy(false); setShowDelOld(false); }
  };

  const isClosed = (t: Trade) => t.status === "win" || t.status === "loss";
  const shown = filter === "all"
    ? trades
    : trades.filter(t => t.status === filter);
  const pages = Math.ceil(total / PAGE);
  const page  = Math.floor(offset / PAGE) + 1;

  return (
    <Layout>
      <div style={{ maxWidth: 420, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div style={{
              fontFamily: "var(--app-font-mono)", fontSize: 10,
              letterSpacing: "0.25em", color: TEAL, fontWeight: 700, marginBottom: 6,
            }}>HISTORIAL COMPLETO</div>
            <div style={{
              fontFamily: "var(--app-font-sans)", fontWeight: 800,
              fontSize: 26, color: WHITE, letterSpacing: "-1px", lineHeight: 1,
            }}>{total} operaciones</div>
          </div>
          <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
            <button onClick={() => setShowDelOld(true)} style={{
              fontFamily: "var(--app-font-mono)", fontSize: 9, letterSpacing: "0.12em",
              padding: "7px 12px", borderRadius: 8,
              background: BG_AMB, color: AMBER, border: `1px solid ${BDR_AMB}`,
              cursor: "pointer", fontWeight: 700,
            }}>−7 DIAS</button>
            <button onClick={() => setShowDelAll(true)} style={{
              fontFamily: "var(--app-font-mono)", fontSize: 9, letterSpacing: "0.12em",
              padding: "7px 12px", borderRadius: 8,
              background: BG_LOSS, color: RED, border: `1px solid ${BDR_LSS}`,
              cursor: "pointer", fontWeight: 700,
            }}>BORRAR</button>
          </div>
        </div>

        {/* Mensaje feedback */}
        {msg && (
          <div style={{
            padding: "12px 16px", borderRadius: 10, display: "flex",
            alignItems: "center", justifyContent: "space-between",
            background: BG_WIN, border: `1px solid ${BDR_WIN}`,
          }}>
            <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, color: TEAL }}>{msg}</span>
            <button onClick={() => setMsg("")} style={{ color: DIM, fontSize: 14, background: "none", border: "none", cursor: "pointer" }}>✕</button>
          </div>
        )}

        {/* ── POSICIONES ACTIVAS ─────────────────────────────────────────── */}
        {botStatus && (() => {
          const escalonPos: any[] = Object.values(botStatus.openPositions ?? {});
          const mpPairs: any[]    = botStatus.mpPairs ?? [];
          const prices: Record<string,number> = botStatus.currentPrices ?? {};
          const hasActive = escalonPos.length > 0 || mpPairs.length > 0;
          if (!hasActive) return null;
          return (
            <div style={{
              background: CARD,
              border: `1px solid ${LINE}`, borderRadius: 8, overflow: "hidden",
            }}>
              <div style={{
                padding: "14px 18px 10px",
                borderBottom: `1px solid ${LINE}`,
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: TEAL, boxShadow: `0 0 6px ${TEAL}` }} />
                <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, letterSpacing: "0.2em", color: TEAL, fontWeight: 700 }}>
                  POSICIONES ABIERTAS AHORA · {escalonPos.length + mpPairs.length}
                </div>
              </div>

              {/* Escalon abiertos */}
              {escalonPos.map((pos: any, _posIdx: number) => {
                const curPrice = prices[pos.symbol] ?? 0;
                const entry = Number(pos.entryPrice ?? 0);
                const sl = Number(pos.stopLoss ?? 0);
                const isLong = pos.side === "LONG" || pos.side === "Buy";
                const pnlPct = curPrice && entry ? ((curPrice - entry) / entry * 100 * (isLong ? 1 : -1)) : 0;
                const slDistPct = entry && sl ? Math.abs((sl - entry) / entry * 100) : 0;
                const sym = pos.symbol?.replace?.("USDT", "") ?? pos.symbol;
                return (
                  <div key={`${pos.symbol}_${pos.side ?? _posIdx}`} style={{
                    padding: "12px 18px",
                    borderBottom: `1px solid ${LINE}`,
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                  }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                        <span style={{ fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 13, color: WHITE }}>{sym}</span>
                        <span style={{
                          fontFamily: "var(--app-font-mono)", fontSize: 9, fontWeight: 700,
                          padding: "2px 6px", borderRadius: 4,
                          background: isLong ? BG_WIN : BG_LOSS,
                          color: isLong ? TEAL : RED,
                          border: `1px solid ${isLong ? BDR_WIN : BDR_LSS}`,
                        }}>{isLong ? "LONG" : "SHORT"}</span>
                        <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM }}>{pos.leverage}×</span>
                      </div>
                      <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: DIM }}>
                        Entrada {px(entry)}
                        {sl > 0 && <span style={{ color: RED, marginLeft: 6 }}>SL {px(sl)} <span style={{ color: "#9a3a3a" }}>({slDistPct.toFixed(1)}%)</span></span>}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{
                        fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 14,
                        color: pnlPct >= 0 ? TEAL : RED,
                      }}>
                        {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                      </div>
                      {curPrice > 0 && (
                        <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM }}>{px(curPrice)}</div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* MP pares activos */}
              {mpPairs.map((p: any) => {
                const curPrice = prices[p.symbol] ?? 0;
                const entry = Number(p.entryPrice ?? 0);
                const sym = p.symbol?.replace?.("USDT", "") ?? p.symbol;
                const longPnlPct = entry && curPrice ? ((curPrice - entry) / entry * 100) : 0;
                const shortPnlPct = -longPnlPct;
                const lca = Number(p.longCloseAt ?? 0);
                const sca = Number(p.shortCloseAt ?? 0);
                return (
                  <div key={p.symbol} style={{
                    padding: "12px 18px",
                    borderBottom: `1px solid ${LINE}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 13, color: WHITE }}>{sym}</span>
                        <span style={{
                          fontFamily: "var(--app-font-mono)", fontSize: 9, fontWeight: 700,
                          padding: "2px 6px", borderRadius: 4,
                          background: "#0a0510", color: AMBER, border: `1px solid #2a1800`,
                        }}>MP</span>
                      </div>
                      {curPrice > 0 && (
                        <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: DIM }}>{px(curPrice)}</span>
                      )}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      <div style={{
                        background: BG_WIN, border: `1px solid ${BDR_WIN}`,
                        borderRadius: 8, padding: "6px 10px",
                      }}>
                        <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, color: TEAL, marginBottom: 2 }}>LONG</div>
                        <div style={{ fontFamily: "var(--app-font-mono)", fontWeight: 700, fontSize: 11, color: longPnlPct >= 0 ? TEAL : RED }}>
                          {longPnlPct >= 0 ? "+" : ""}{longPnlPct.toFixed(2)}%
                        </div>
                        {lca > 0 && <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, color: DIM }}>TP {px(lca)}</div>}
                      </div>
                      <div style={{
                        background: BG_LOSS, border: `1px solid ${BDR_LSS}`,
                        borderRadius: 8, padding: "6px 10px",
                      }}>
                        <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, color: RED, marginBottom: 2 }}>SHORT</div>
                        <div style={{ fontFamily: "var(--app-font-mono)", fontWeight: 700, fontSize: 11, color: shortPnlPct >= 0 ? TEAL : RED }}>
                          {shortPnlPct >= 0 ? "+" : ""}{shortPnlPct.toFixed(2)}%
                        </div>
                        {sca > 0 && <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 8, color: DIM }}>TP {px(sca)}</div>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* ── SUMMARY ────────────────────────────────────────────────────── */}
        {summary && (() => {
          const closedTrades = (filter === "all" ? trades : trades.filter(t => t.status === filter)).filter(t => t.status === "win" || t.status === "loss");
          const totalGained = closedTrades.filter(t => parseFloat(t.pnl) > 0).reduce((s, t) => s + parseFloat(t.pnl), 0);
          const totalLost = closedTrades.filter(t => parseFloat(t.pnl) < 0).reduce((s, t) => s + parseFloat(t.pnl), 0);
          return (
          <div style={{
            background: CARD,
            border: `1px solid ${LINE}`, borderRadius: 8, padding: "18px 20px",
          }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 0, marginBottom: 16 }}>
              {[
                { label: "Wins",     val: String(summary.wins),                  color: TEAL },
                { label: "Losses",   val: String(summary.losses),                color: RED  },
                { label: "Win Rate", val: summary.winRate.toFixed(0) + "%",      color: summary.winRate >= 50 ? TEAL : RED },
                { label: "Neto",     val: (summary.totalPnl >= 0 ? "+" : "") + summary.totalPnl.toFixed(2), color: summary.totalPnl >= 0 ? TEAL : RED },
              ].map((s, i) => (
                <div key={s.label} style={{
                  textAlign: "center",
                  borderLeft: i > 0 ? `1px solid ${LINE}` : "none",
                  padding: "0 8px",
                }}>
                  <div style={{
                    fontFamily: "var(--app-font-mono)", fontWeight: 800,
                    fontSize: i === 3 ? 14 : 22, color: s.color,
                    letterSpacing: i === 3 ? "-0.3px" : "-0.5px",
                    marginBottom: 4,
                  }}>{s.val}</div>
                  <Label color={DIM}>{s.label}</Label>
                </div>
              ))}
            </div>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10,
              paddingTop: 14, borderTop: `1px solid ${LINE}`,
            }}>
              <div style={{
                background: BG_WIN, border: `1px solid ${BDR_WIN}`,
                borderRadius: 10, padding: "12px 14px", textAlign: "center",
              }}>
                <Label color={TEAL}>Ganado</Label>
                <div style={{
                  fontFamily: "var(--app-font-mono)", fontWeight: 800,
                  fontSize: 20, color: TEAL, marginTop: 4,
                }}>+${totalGained.toFixed(2)}</div>
              </div>
              <div style={{
                background: BG_LOSS, border: `1px solid ${BDR_LSS}`,
                borderRadius: 10, padding: "12px 14px", textAlign: "center",
              }}>
                <Label color={RED}>Perdido</Label>
                <div style={{
                  fontFamily: "var(--app-font-mono)", fontWeight: 800,
                  fontSize: 20, color: RED, marginTop: 4,
                }}>-${Math.abs(totalLost).toFixed(2)}</div>
              </div>
            </div>
          </div>);
        })()}

        {/* ── FILTROS ────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 6 }}>
          {(["all","win","loss"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              fontFamily: "var(--app-font-mono)", fontSize: 9,
              letterSpacing: "0.15em", fontWeight: 700,
              padding: "8px 16px", borderRadius: 8,
              background: filter === f
                ? (f === "win" ? BG_WIN : f === "loss" ? BG_LOSS : CARD)
                : DEEP,
              color: filter === f
                ? (f === "win" ? TEAL : f === "loss" ? RED : WHITE)
                : DIM,
              border: `1px solid ${filter === f
                ? (f === "win" ? BDR_WIN : f === "loss" ? BDR_LSS : LINE)
                : LINE}`,
              cursor: "pointer",
            }}>
              {f === "all" ? "TODAS" : f === "win" ? "GANADORAS" : "PERDEDORAS"}
            </button>
          ))}
        </div>

        {/* ── LISTA ──────────────────────────────────────────────────────── */}
        {loading ? (
          <div style={{
            padding: "48px 24px", textAlign: "center",
            background: CARD,
            border: `1px solid ${LINE}`, borderRadius: 8,
          }}>
            <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, letterSpacing: "0.2em", color: DIM }}>
              CARGANDO...
            </div>
          </div>
        ) : shown.length === 0 ? (
          <div style={{
            padding: "48px 24px", textAlign: "center",
            background: CARD,
            border: `1px solid ${LINE}`, borderRadius: 8,
          }}>
            <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, letterSpacing: "0.25em", color: TEAL, marginBottom: 12, fontWeight: 700 }}>
              SIN OPERACIONES
            </div>
            <div style={{ fontFamily: "var(--app-font-sans)", fontWeight: 700, fontSize: 18, color: WHITE, marginBottom: 6 }}>
              {filter !== "all" ? "Cambia el filtro" : "Suelta el bot"}
            </div>
            <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: DIM }}>
              {filter !== "all" ? "para ver otras operaciones" : "para comenzar a operar"}
            </div>
          </div>
        ) : (() => {
          const runningTotals: number[] = [];
          const reversedShown = [...shown].reverse();
          let cumPnl = 0;
          for (const t of reversedShown) {
            cumPnl += parseFloat(t.pnl ?? "0");
            runningTotals.push(cumPnl);
          }
          runningTotals.reverse();

          return (
          <div style={{
            background: CARD,
            border: `1px solid ${LINE}`, borderRadius: 8, overflow: "hidden",
          }}>
            {shown.map((t, i) => {
              const pnl    = parseFloat(t.pnl ?? "0");
              const closed = isClosed(t);
              const isWin  = closed && t.status === "win";
              const col    = !closed ? DIM : (isWin ? TEAL : RED);
              const accent = !closed ? "#1a1a2e" : (isWin ? BDR_WIN : BDR_LSS);
              const bg     = !closed ? "#08081a" : (isWin ? BG_WIN : BG_LOSS);
              const rb     = getBadge(t.status);
              const coin     = SYM[t.symbol] ?? t.symbol?.replace("USDT","");
              const hold     = parseFloat(t.computed_hold_min ?? t.hold_minutes ?? "0");
              const entry    = parseFloat(t.entry_price ?? "0");
              const exit     = parseFloat(t.exit_price ?? "0");
              const moved    = entry > 0 && exit > 0
                ? ((exit - entry) / entry * 100 * (t.direction === "LONG" ? 1 : -1))
                : null;
              const cumBalance = runningTotals[i] ?? 0;

              return (
                <div key={t.id} style={{
                  padding: "14px 18px",
                  background: i % 2 === 0 ? bg : CARD,
                  borderLeft: `3px solid ${accent}`,
                  borderTop: i > 0 ? `1px solid ${LINE}` : "none",
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{
                        fontFamily: "var(--app-font-mono)", fontSize: 9, fontWeight: 700,
                        letterSpacing: "0.12em", padding: "3px 7px", borderRadius: 5,
                        background: t.direction === "LONG" ? BG_WIN : BG_LOSS,
                        color: t.direction === "LONG" ? TEAL : RED,
                        border: `1px solid ${t.direction === "LONG" ? BDR_WIN : BDR_LSS}`,
                      }}>{t.direction === "LONG" ? "LONG" : "SHORT"}</span>
                      <span style={{ fontFamily: "var(--app-font-sans)", fontWeight: 700, fontSize: 15, color: WHITE }}>{coin}</span>
                      <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: MID }}>{t.leverage}x</span>
                      <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: DIM }}>{holdDur(hold)}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{
                        fontFamily: "var(--app-font-mono)", fontWeight: 800,
                        fontSize: 16, color: col, letterSpacing: "-0.3px",
                      }}>
                        {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                      </span>
                      {rb.label !== "\u2014" && (
                        <span style={{
                          fontFamily: "var(--app-font-mono)", fontSize: 9, fontWeight: 700,
                          padding: "3px 7px", borderRadius: 5,
                          background: rb.bg, color: rb.text, letterSpacing: "0.08em",
                        }}>{rb.label}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: SOFT }}>
                        {px(entry)}
                      </span>
                      <span style={{ color: DIM, fontSize: 10 }}>{"\u2192"}</span>
                      <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: col, fontWeight: 700 }}>
                        {closed ? px(exit) : "\u2014"}
                      </span>
                      {closed && moved !== null && (
                        <span style={{
                          fontFamily: "var(--app-font-mono)", fontSize: 9,
                          color: moved >= 0 ? TEAL : RED,
                          background: moved >= 0 ? BG_WIN : BG_LOSS,
                          border: `1px solid ${moved >= 0 ? BDR_WIN : BDR_LSS}`,
                          padding: "2px 6px", borderRadius: 5,
                        }}>
                          {moved >= 0 ? "+" : ""}{moved.toFixed(3)}%
                        </span>
                      )}
                    </div>
                    <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM }}>
                      {closed ? fmtDate(t.close_at) : fmtDate(t.open_at)}
                    </span>
                  </div>
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    paddingTop: 5, borderTop: `1px solid rgba(255,255,255,0.04)`,
                  }}>
                    <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM, letterSpacing: "0.1em" }}>
                      BALANCE
                    </span>
                    <span style={{
                      fontFamily: "var(--app-font-mono)", fontSize: 12, fontWeight: 800,
                      color: cumBalance >= 0 ? TEAL : RED,
                    }}>
                      {cumBalance >= 0 ? "+" : ""}{cumBalance.toFixed(2)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>);
        })()}

        {/* ── PAGINACIÓN ─────────────────────────────────────────────────── */}
        {pages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <button
              onClick={() => load(Math.max(0, offset - PAGE))}
              disabled={offset === 0}
              style={{
                fontFamily: "var(--app-font-mono)", fontSize: 10, letterSpacing: "0.1em",
                padding: "10px 18px", borderRadius: 10,
                background: DEEP, color: MID, border: `1px solid ${LINE}`,
                cursor: offset === 0 ? "not-allowed" : "pointer", opacity: offset === 0 ? 0.3 : 1,
              }}>ANTERIOR</button>
            <span style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: DIM, letterSpacing: "0.1em" }}>
              {page} / {pages}
            </span>
            <button
              onClick={() => load(offset + PAGE)}
              disabled={offset + PAGE >= total}
              style={{
                fontFamily: "var(--app-font-mono)", fontSize: 10, letterSpacing: "0.1em",
                padding: "10px 18px", borderRadius: 10,
                background: DEEP, color: MID, border: `1px solid ${LINE}`,
                cursor: offset + PAGE >= total ? "not-allowed" : "pointer",
                opacity: offset + PAGE >= total ? 0.3 : 1,
              }}>SIGUIENTE</button>
          </div>
        )}

        <div style={{ height: 16 }} />
      </div>

      {/* ── MODAL: BORRAR TODO ───────────────────────────────────────────── */}
      {showDelAll && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 200,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 20px", background: "rgba(0,0,0,0.9)",
        }} onClick={() => setShowDelAll(false)}>
          <div style={{
            width: "100%", maxWidth: 380, borderRadius: 10, padding: "28px 24px",
            background: CARD,
            border: `1px solid ${BDR_LSS}`,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, letterSpacing: "0.25em", color: RED, fontWeight: 700, marginBottom: 10 }}>
                ELIMINAR HISTORIAL
              </div>
              <div style={{ fontFamily: "var(--app-font-sans)", fontWeight: 800, fontSize: 20, color: WHITE, marginBottom: 8 }}>
                {total} operaciones
              </div>
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, color: MID }}>
                Esta acción no se puede deshacer.
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button onClick={() => setShowDelAll(false)} style={{
                padding: "14px", borderRadius: 12, fontFamily: "var(--app-font-mono)",
                fontWeight: 700, fontSize: 12, letterSpacing: "0.08em",
                background: DEEP, color: MID, border: `1px solid ${LINE}`, cursor: "pointer",
              }}>CANCELAR</button>
              <button onClick={clearAll} disabled={busy} style={{
                padding: "14px", borderRadius: 12, fontFamily: "var(--app-font-mono)",
                fontWeight: 700, fontSize: 12, letterSpacing: "0.08em",
                background: RED, color: WHITE, border: "none",
                cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
              }}>{busy ? "BORRANDO..." : "BORRAR TODO"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: BORRAR VIEJOS ─────────────────────────────────────────── */}
      {showDelOld && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 200,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 20px", background: "rgba(0,0,0,0.9)",
        }} onClick={() => setShowDelOld(false)}>
          <div style={{
            width: "100%", maxWidth: 380, borderRadius: 10, padding: "28px 24px",
            background: CARD,
            border: `1px solid ${BDR_AMB}`,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, letterSpacing: "0.25em", color: AMBER, fontWeight: 700, marginBottom: 10 }}>
                LIMPIAR HISTORIAL
              </div>
              <div style={{ fontFamily: "var(--app-font-sans)", fontWeight: 800, fontSize: 20, color: WHITE, marginBottom: 8 }}>
                Operaciones −7 días
              </div>
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, color: MID }}>
                Se conservan los últimos 7 días.
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button onClick={() => setShowDelOld(false)} style={{
                padding: "14px", borderRadius: 12, fontFamily: "var(--app-font-mono)",
                fontWeight: 700, fontSize: 12, letterSpacing: "0.08em",
                background: DEEP, color: MID, border: `1px solid ${LINE}`, cursor: "pointer",
              }}>CANCELAR</button>
              <button onClick={clearOld} disabled={busy} style={{
                padding: "14px", borderRadius: 12, fontFamily: "var(--app-font-mono)",
                fontWeight: 700, fontSize: 12, letterSpacing: "0.08em",
                background: AMBER, color: "#0a0500", border: "none",
                cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
              }}>{busy ? "BORRANDO..." : "BORRAR −7 DIAS"}</button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
