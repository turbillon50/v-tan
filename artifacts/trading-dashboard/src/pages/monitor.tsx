import { useEffect, useMemo, useRef, useState } from "react";
import { Layout } from "@/components/layout";
import { BASE_URL } from "@/lib/api";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer,
} from "recharts";

/* ── palette — curva infinita de Luis ── */
const GREEN  = "#7CFF3C";
const RED    = "#FF3C3C";
const AMBER  = "#FFB800";
const DIM    = "#5a7a5a";
const DIM2   = "#7a9a7a";
const WHITE  = "#FFFFFF";
const CARD   = "#050f05";
const CARD2  = "#091409";
const LINE   = "#0f2010";
const BG     = "#020c02";

/* ── helpers ── */
const fmt    = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUSD = (n: number, d = 2) => "$" + fmt(n, d);
const fmtPct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fmtSign = (n: number) => (n >= 0 ? "+" : "") + fmtUSD(n);

type Range = "1h" | "6h" | "24h" | "7d" | "30d";
const RANGES: Range[] = ["1h", "6h", "24h", "7d", "30d"];

function timeLabel(epochMs: number, range: Range): string {
  const d = new Date(Number(epochMs));
  if (range === "1h" || range === "6h") {
    return d.getUTCHours().toString().padStart(2, "0") + ":" + d.getUTCMinutes().toString().padStart(2, "0");
  }
  if (range === "24h") {
    return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + d.getUTCHours().toString().padStart(2, "0") + "h";
  }
  return (d.getUTCMonth() + 1) + "/" + d.getUTCDate();
}

function StatCard({ label, value, sub, valueColor = WHITE }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div style={{
      flex: 1, minWidth: 0,
      background: CARD2,
      border: `1px solid ${LINE}`,
      borderRadius: 10,
      padding: "12px 14px",
    }}>
      <div style={{ fontFamily: "monospace", fontSize: 8, letterSpacing: "0.2em", textTransform: "uppercase" as const, color: DIM2, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 18, color: valueColor, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontFamily: "monospace", fontSize: 8, color: DIM, marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

function HealthBanner({ state, msg }: { state: "green" | "amber" | "red"; msg: string }) {
  const colors = { green: GREEN, amber: AMBER, red: RED };
  const bgs    = { green: "rgba(124,255,60,0.07)", amber: "rgba(255,184,0,0.07)", red: "rgba(255,60,60,0.08)" };
  const c = colors[state];
  const bg = bgs[state];
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      background: bg, border: `1px solid ${c}30`,
      borderRadius: 8, padding: "8px 14px",
    }}>
      <div style={{ width: 7, height: 7, borderRadius: "50%", background: c, boxShadow: `0 0 8px ${c}` }} />
      <span style={{ fontFamily: "monospace", fontSize: 9, color: c, letterSpacing: "0.12em" }}>{state.toUpperCase()}</span>
      <span style={{ fontFamily: "monospace", fontSize: 9, color: DIM2, letterSpacing: "0.04em" }}>{msg}</span>
    </div>
  );
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const v = Number(payload[0]?.value ?? 0);
  const t = payload[0]?.payload?.time;
  return (
    <div style={{ background: CARD, border: `1px solid ${GREEN}30`, borderRadius: 8, padding: "8px 12px" }}>
      <div style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 13, color: GREEN }}>{fmtUSD(v)}</div>
      {t && <div style={{ fontFamily: "monospace", fontSize: 8, color: DIM2, marginTop: 3 }}>{new Date(Number(t)).toUTCString().slice(5, 22)}</div>}
    </div>
  );
}

/* ── Capital contribution modal ── */
function ContribModal({ onClose, onAdd }: { onClose: () => void; onAdd: (usdt: number, mxn: number | null, rate: number | null, notes: string) => Promise<void> }) {
  const [usdt, setUsdt]   = useState("");
  const [mxn, setMxn]     = useState("");
  const [rate, setRate]   = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const inputStyle = {
    background: CARD2, border: `1px solid ${LINE}`, borderRadius: 7, padding: "8px 12px",
    fontFamily: "monospace", fontSize: 12, color: WHITE, width: "100%", boxSizing: "border-box" as const,
    outline: "none",
  };
  const labelStyle = { fontFamily: "monospace", fontSize: 8, color: DIM2, letterSpacing: "0.15em", display: "block" as const, marginBottom: 4, textTransform: "uppercase" as const };
  const handleSave = async () => {
    const usdtN = parseFloat(usdt);
    if (!Number.isFinite(usdtN) || usdtN <= 0) return;
    setSaving(true);
    setSaveErr(null);
    try {
      await onAdd(usdtN, mxn ? parseFloat(mxn) : null, rate ? parseFloat(rate) : null, notes);
      onClose();
    } catch (e: any) {
      setSaveErr(e?.message ?? "Error al guardar");
    } finally { setSaving(false); }
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 14, padding: 24, width: "min(340px, 90vw)", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 14, color: WHITE, letterSpacing: "0.06em" }}>REGISTRAR DEPÓSITO</div>
        <div><label style={labelStyle}>Monto USDT *</label><input type="number" placeholder="0.00" value={usdt} onChange={e => setUsdt(e.target.value)} style={inputStyle} /></div>
        <div><label style={labelStyle}>Monto MXN (opcional)</label><input type="number" placeholder="0.00" value={mxn} onChange={e => setMxn(e.target.value)} style={inputStyle} /></div>
        <div><label style={labelStyle}>Tipo de cambio (opcional)</label><input type="number" placeholder="0.00" value={rate} onChange={e => setRate(e.target.value)} style={inputStyle} /></div>
        <div><label style={labelStyle}>Notas (opcional)</label><input type="text" placeholder="Primer depósito..." value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} /></div>
        {saveErr && <div style={{ fontFamily: "monospace", fontSize: 9, color: RED }}>{saveErr}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: `1px solid ${LINE}`, background: "transparent", color: DIM2, fontFamily: "monospace", fontSize: 10, cursor: "pointer" }}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} style={{ flex: 2, padding: "10px 0", borderRadius: 8, border: `1px solid ${GREEN}60`, background: `${GREEN}15`, color: GREEN, fontFamily: "monospace", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>
            {saving ? "Guardando..." : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════════ */
export default function Monitor() {
  const [range, setRange]               = useState<Range>(() => (localStorage.getItem("monitor-range") as Range) ?? "24h");
  const [botState, setBotState]         = useState<any>(null);
  const [history, setHistory]           = useState<any[]>([]);
  const [contributions, setContribs]    = useState<{ total_usdt: number; contributions: any[] }>({ total_usdt: 0, contributions: [] });
  const [lastUpdated, setLastUpdated]   = useState<Date | null>(null);
  const [error, setError]               = useState(false);
  const [showContrib, setShowContrib]   = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  // Persist range preference
  useEffect(() => { localStorage.setItem("monitor-range", range); }, [range]);

  // ── Polling ─────────────────────────────────────────────
  const loadAll = async () => {
    try {
      const [botRes, histRes, contribRes] = await Promise.all([
        fetch(`${BASE_URL}api/bot/status`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${BASE_URL}api/tanit/balance-history?range=${range}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${BASE_URL}api/tanit/capital-contributions`).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      if (!mountedRef.current) return;
      if (botRes) setBotState(botRes);
      if (histRes?.ok) setHistory(histRes.history ?? []);
      if (contribRes?.ok) setContribs({ total_usdt: contribRes.total_usdt ?? 0, contributions: contribRes.contributions ?? [] });
      // Only mark refresh successful when the primary data source responded
      setError(!botRes);
      if (botRes) setLastUpdated(new Date());
    } catch {
      if (mountedRef.current) setError(true);
    }
  };

  useEffect(() => {
    loadAll();
    const id = setInterval(loadAll, 30_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // ── Derived state ───────────────────────────────────────
  const live         = !!botState?.liveMode;
  const equity       = live ? (botState?.liveBalance ?? 0) : (botState?.effectiveBalance ?? 0);
  const available    = live ? (botState?.liveAvailable ?? equity) : (botState?.available ?? equity);
  const tradeLog     = useMemo<any[]>(() => botState?.tradeLog ?? [], [botState]);
  const sessionPnl   = Number(botState?.sessionPnl ?? 0);
  const openPositions = useMemo<any[]>(() => Object.values(botState?.openPositions ?? {}), [botState]);
  const mpPairs      = botState?.mpPairs ?? [];
  const allPositions = useMemo(() => [...openPositions, ...mpPairs], [openPositions, mpPairs]);
  const totalUPnL    = allPositions.reduce((s, p) => s + Number(p.unrealizedPnl ?? 0), 0);
  const marginHeat   = equity > 0 ? ((equity - available) / equity * 100) : 0;

  const wins   = tradeLog.filter((t: any) => t.pnl > 0).length;
  const losses = tradeLog.filter((t: any) => t.pnl < 0).length;
  const winRate = (wins + losses) > 0 ? (wins / (wins + losses) * 100) : null;
  const totalFees = Number(botState?.totalFees ?? 0);
  const grossWins  = tradeLog.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(tradeLog.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLosses > 0 ? grossWins / grossLosses : null;

  // Chart data
  const chartData = useMemo(() => {
    if (history.length === 0) {
      // Fallback: use botState session balance history
      const fallback: any[] = botState?.balanceHistory ?? [];
      return fallback.map((h: any) => ({ time: h.time, equity: h.balance ?? h.equity }));
    }
    return history.map(h => ({ time: Number(h.time), equity: Number(h.equity ?? h.balance) }));
  }, [history, botState]);

  const chartMin = useMemo(() => chartData.length ? Math.min(...chartData.map(d => d.equity)) * 0.998 : 0, [chartData]);
  const chartMax = useMemo(() => chartData.length ? Math.max(...chartData.map(d => d.equity)) * 1.002 : 1, [chartData]);

  const rangeStart = chartData[0]?.equity ?? equity;
  const rangeChange = equity - rangeStart;
  const rangeChangePct = rangeStart > 0 ? (rangeChange / rangeStart * 100) : 0;
  const isUp = rangeChange >= 0;
  const accentColor = isUp ? GREEN : RED;

  const capitalContributed = contributions.total_usdt;
  const tanitsActualPnl = equity - capitalContributed;

  // Sort positions by UPnL ascending (worst first)
  const sortedPositions = useMemo(() =>
    [...allPositions].sort((a, b) => Number(a.unrealizedPnl ?? 0) - Number(b.unrealizedPnl ?? 0)),
    [allPositions]
  );

  // System health
  const health: "green" | "amber" | "red" = (() => {
    if (marginHeat > 90) return "red";
    if (!botState) return "amber";
    if (!live) return "amber";
    if (botState?.active === false) return "amber";
    return "green";
  })();
  const healthMsg = (() => {
    if (!botState) return "Sin conexión al backend";
    if (!live) return "Modo paper — no opera mainnet";
    if (botState?.active === false) return "Bot detenido";
    if (marginHeat > 90) return `Margin heat crítico: ${marginHeat.toFixed(1)}%`;
    return `${allPositions.length} posición${allPositions.length !== 1 ? "es" : ""} · Bybit mainnet · WT ${winRate != null ? winRate.toFixed(0) + "%" : "—"}`;
  })();

  const addContribution = async (usdt: number, mxn: number | null, rate: number | null, notes: string) => {
    const res = await fetch(`${BASE_URL}api/tanit/capital-contributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_usdt: usdt, amount_mxn: mxn, exchange_rate: rate, notes }),
    });
    if (!res.ok) throw new Error(`Error ${res.status} al guardar depósito`);
    await loadAll();
  };

  return (
    <Layout>
      <div style={{ maxWidth: 800, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10, paddingBottom: 32, background: BG, minHeight: "100vh" }}>

        {/* ── Header ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 4px 4px" }}>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: 8, letterSpacing: "0.3em", color: `${GREEN}80`, textTransform: "uppercase" as const }}>TANIT · BYBIT MAINNET</div>
            <div style={{ fontFamily: "monospace", fontWeight: 900, fontSize: 30, color: WHITE, letterSpacing: "-1.5px", lineHeight: 1.1 }}>
              {fmtUSD(equity)}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5 }}>
              <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 14, color: accentColor }}>
                {fmtSign(rangeChange)}
              </span>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: `${accentColor}90` }}>
                {fmtPct(rangeChangePct)}
              </span>
              <span style={{ fontFamily: "monospace", fontSize: 7, padding: "2px 7px", borderRadius: 5, background: `${accentColor}18`, color: `${accentColor}80`, letterSpacing: "0.06em" }}>
                {range.toUpperCase()}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            {live && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: GREEN, boxShadow: `0 0 10px ${GREEN}` }} />
                <span style={{ fontFamily: "monospace", fontSize: 8, color: GREEN, letterSpacing: "0.15em", fontWeight: 700 }}>LIVE</span>
              </div>
            )}
            {lastUpdated && (
              <div style={{ fontFamily: "monospace", fontSize: 7, color: DIM }}>
                {lastUpdated.toLocaleTimeString()}
              </div>
            )}
            {error && <div style={{ fontFamily: "monospace", fontSize: 7, color: RED }}>⚠ ERROR</div>}
          </div>
        </div>

        {/* ── Health banner ── */}
        <HealthBanner state={health} msg={healthMsg} />

        {/* ── Stats row ── */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
          <StatCard
            label="Libre (disponible)"
            value={fmtUSD(available)}
            sub={`Libre / Total`}
            valueColor={GREEN}
          />
          <StatCard
            label="UPnL posiciones"
            value={fmtSign(totalUPnL)}
            valueColor={totalUPnL >= 0 ? GREEN : RED}
          />
          <StatCard
            label="Margin heat"
            value={marginHeat.toFixed(1) + "%"}
            valueColor={marginHeat > 80 ? RED : marginHeat > 50 ? AMBER : GREEN}
          />
          <StatCard
            label="PyG hoy (sesión)"
            value={fmtSign(sessionPnl)}
            valueColor={sessionPnl >= 0 ? GREEN : RED}
          />
        </div>

        {/* ── Capital contributed ── */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: CARD2, border: `1px solid ${LINE}`, borderRadius: 10, padding: "12px 16px",
        }}>
          <div>
            <div style={{ fontFamily: "monospace", fontSize: 8, letterSpacing: "0.18em", color: DIM2, textTransform: "uppercase" as const, marginBottom: 5 }}>Capital aportado por Luis</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 18, color: WHITE }}>{fmtUSD(capitalContributed)}</span>
              <span style={{ fontFamily: "monospace", fontSize: 10, color: tanitsActualPnl >= 0 ? GREEN : RED }}>
                PyG real de Tanit: {fmtSign(tanitsActualPnl)}
              </span>
            </div>
          </div>
          <button onClick={() => setShowContrib(true)} style={{
            background: `${GREEN}15`, border: `1px solid ${GREEN}50`, borderRadius: 8,
            color: GREEN, fontFamily: "monospace", fontSize: 9, padding: "8px 14px",
            cursor: "pointer", letterSpacing: "0.06em", fontWeight: 700,
          }}>
            + Depósito
          </button>
        </div>

        {/* ── Chart card ── */}
        <div style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 14, overflow: "hidden" }}>
          {/* Range selector */}
          <div style={{ display: "flex", gap: 3, padding: "12px 16px 4px" }}>
            {RANGES.map(r => (
              <button key={r} onClick={() => setRange(r)} style={{
                flex: 1, padding: "6px 0", borderRadius: 7, cursor: "pointer",
                border: range === r ? `1px solid ${GREEN}55` : "1px solid transparent",
                background: range === r ? `${GREEN}18` : "rgba(255,255,255,0.03)",
                color: range === r ? GREEN : DIM2,
                fontFamily: "monospace", fontSize: 9,
                fontWeight: range === r ? 800 : 500,
                transition: "all 0.12s",
              }}>
                {r.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Chart */}
          <div style={{ padding: "8px 0 4px" }}>
            {chartData.length >= 2 ? (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <defs>
                    <linearGradient id="tanit-gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"   stopColor={GREEN} stopOpacity={0.3} />
                      <stop offset="95%"  stopColor={GREEN} stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
                  <XAxis
                    dataKey="time"
                    tickFormatter={t => timeLabel(t, range)}
                    tick={{ fontFamily: "monospace", fontSize: 8, fill: DIM2 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[chartMin, chartMax]}
                    tickFormatter={v => "$" + Number(v).toFixed(2)}
                    tick={{ fontFamily: "monospace", fontSize: 8, fill: DIM2 }}
                    axisLine={false}
                    tickLine={false}
                    width={58}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke={GREEN}
                    strokeWidth={2.2}
                    fill="url(#tanit-gradient)"
                    dot={false}
                    activeDot={{ r: 4, fill: GREEN, stroke: "#fff", strokeWidth: 1.5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10 }}>
                <div style={{ fontFamily: "monospace", fontSize: 9, color: DIM2, letterSpacing: "0.1em" }}>CONSTRUYENDO CURVA</div>
                <div style={{ fontFamily: "monospace", fontSize: 8, color: DIM }}>
                  {chartData.length === 0 ? "Los snapshots se escriben cada 5 min — espera el primero" : `${chartData.length} punto${chartData.length !== 1 ? "s" : ""} registrados`}
                </div>
              </div>
            )}
          </div>

          {/* Chart footer */}
          {chartData.length >= 2 && (
            <div style={{ display: "flex", gap: 20, padding: "8px 20px 14px", borderTop: `1px solid ${LINE}` }}>
              {[
                { l: "LO", v: fmtUSD(Math.min(...chartData.map(d => d.equity))), c: RED },
                { l: "HI", v: fmtUSD(Math.max(...chartData.map(d => d.equity))), c: GREEN },
                { l: "INICIO PERÍODO", v: fmtUSD(chartData[0].equity), c: DIM2 },
                { l: "ACTUAL", v: fmtUSD(equity), c: accentColor },
              ].map(({ l, v, c }) => (
                <div key={l}>
                  <div style={{ fontFamily: "monospace", fontSize: 7, color: DIM, letterSpacing: "0.12em" }}>{l}</div>
                  <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 11, color: c }}>{v}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Open positions table ── */}
        {sortedPositions.length > 0 && (
          <div style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 14, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px 8px", borderBottom: `1px solid ${LINE}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "0.2em", color: DIM2, textTransform: "uppercase" as const }}>Posiciones abiertas ({sortedPositions.length})</span>
              <span style={{ fontFamily: "monospace", fontSize: 9, color: totalUPnL >= 0 ? GREEN : RED, fontWeight: 700 }}>
                UPnL total: {fmtSign(totalUPnL)}
              </span>
            </div>
            {sortedPositions.map((pos: any, i: number) => {
              const upnl  = Number(pos.unrealizedPnl ?? 0);
              const pnlPct = Number(pos.unrealizedPnlPercent ?? pos.unrealizedPct ?? 0);
              const isCritical = pnlPct < -10;
              const rowColor = upnl >= 0 ? GREEN : (isCritical ? RED : "#FF7A3C");
              return (
                <div key={i} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 16px",
                  borderBottom: i < sortedPositions.length - 1 ? `1px solid ${LINE}` : undefined,
                  background: isCritical ? "rgba(255,60,60,0.04)" : "transparent",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {isCritical && <span style={{ fontSize: 10 }}>🔴</span>}
                    <div>
                      <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 12, color: WHITE }}>
                        {String(pos.symbol ?? "").replace("USDT", "")}
                      </div>
                      <div style={{ fontFamily: "monospace", fontSize: 8, color: pos.direction === "LONG" || pos.side === "Buy" ? GREEN : RED }}>
                        {pos.direction || (pos.side === "Buy" ? "LONG" : "SHORT")} · {pos.leverageX ?? pos.leverage ?? "?"}x
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 12, color: rowColor }}>
                      {fmtSign(upnl)}
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 8, color: rowColor }}>
                      {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── 24h stats ── */}
        {(wins + losses) > 0 && (
          <div style={{ background: CARD2, border: `1px solid ${LINE}`, borderRadius: 14, padding: "14px 16px" }}>
            <div style={{ fontFamily: "monospace", fontSize: 8, letterSpacing: "0.2em", color: DIM2, marginBottom: 12, textTransform: "uppercase" as const }}>Sesión actual · últimos {wins + losses} trades</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
              <StatCard label="Win Rate" value={winRate != null ? winRate.toFixed(1) + "%" : "—"} valueColor={winRate != null && winRate > 50 ? GREEN : RED} />
              <StatCard label="Profit Factor" value={pf != null ? pf.toFixed(2) : "—"} valueColor={pf != null && pf > 1 ? GREEN : RED} />
              <StatCard label="Trades" value={String(wins + losses)} sub={`✓${wins} ✗${losses}`} />
              <StatCard label="PnL sesión" value={fmtSign(sessionPnl)} sub={`fees: ${fmtUSD(totalFees)}`} valueColor={sessionPnl >= 0 ? GREEN : RED} />
            </div>
          </div>
        )}

        {/* ── Footer timestamp ── */}
        <div style={{ textAlign: "center", fontFamily: "monospace", fontSize: 7, color: DIM, letterSpacing: "0.1em" }}>
          {lastUpdated
            ? `ÚLTIMA ACTUALIZACIÓN: ${lastUpdated.toLocaleString()} · AUTO-REFRESH 30s`
            : "CONECTANDO..."}
        </div>

      </div>

      {showContrib && (
        <ContribModal
          onClose={() => setShowContrib(false)}
          onAdd={addContribution}
        />
      )}
    </Layout>
  );
}
