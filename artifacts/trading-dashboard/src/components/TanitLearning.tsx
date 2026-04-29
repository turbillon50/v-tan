import { useState } from "react";

const GREEN  = "#00D4AA";
const RED    = "#F23645";
const AMBER  = "#FF9500";
const PURPLE = "#A78BFA";

const TIER_ORDER = ["ELITE", "HIGH", "MEDIUM", "LOW", "DEAD"];

const SESSION_ORDER = [
  "Late Night",
  "Asia",
  "London",
  "London+NY Overlap",
  "NY Peak",
  "NY Late",
];

const SESSION_DEFAULTS: Record<string, number> = {
  "Late Night":        1.20,
  "Asia":              1.20,
  "London":            1.00,
  "London+NY Overlap": 0.85,
  "NY Peak":           1.00,
  "NY Late":           1.10,
};

const SESSION_KEY_MAP: Record<string, string> = {
  "Late Night":        "mult_late_night",
  "Asia":              "mult_asia",
  "London":            "mult_london",
  "London+NY Overlap": "mult_london_ny",
  "NY Peak":           "mult_ny_peak",
  "NY Late":           "mult_ny_late",
};

const SESSION_HOURS: Record<string, string> = {
  "Late Night":        "00-04",
  "Asia":              "04-08",
  "London":            "08-13",
  "London+NY Overlap": "13-16",
  "NY Peak":           "16-21",
  "NY Late":           "21-24",
};

function multColor(mult: number): string {
  if (mult <= 0.90) return "#00D4AA";
  if (mult <= 1.00) return "#00D4AA";
  if (mult <= 1.10) return "#FF9500";
  return "#F23645";
}

const TIER_COLOR: Record<string, string> = {
  ELITE:  "#FFD700",
  HIGH:   GREEN,
  MEDIUM: AMBER,
  LOW:    "#94A3B8",
  DEAD:   RED,
};

interface CalibrationCycle {
  ts: string;
  cycleNumber: number;
  threshold: number;
  sessionAdjustments: Record<string, number>;
  recentWinRate: number;
  recentTrades: number;
  dbSamples: number;
  dbConfidence: number;
  changes: string[];
}

interface CalibrationData {
  cycleCount: number;
  sessionThresholds: Record<string, number>;
  sessionThresholdBase: Record<string, number>;
  sessionMultipliers?: Record<string, number>;
  last: CalibrationCycle | null;
  history: CalibrationCycle[];
}

export interface TanitLearningData {
  calibration?: CalibrationData;
  symAvoid?: string[];
  symBonus?: Record<string, number>;
  drawdownActive?: boolean;
  drawdownBonus?: number;
  drawdownTriggerPct?: number;
  swapMinAdvantage?: number;
  swapMinAgeMin?: number;
  swapMaxLoss?: number;
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "2px 8px", borderRadius: 6,
      background: `${color}18`, border: `1px solid ${color}44`,
      color, fontSize: 10, fontWeight: 700, fontFamily: "var(--app-font-mono)",
      letterSpacing: "0.06em",
    }}>
      {children}
    </span>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <div style={{
      width: 7, height: 7, borderRadius: "50%",
      background: color, boxShadow: `0 0 6px ${color}`,
      flexShrink: 0,
    }} />
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, letterSpacing: "0.18em",
      color: "rgba(255,255,255,0.3)", textTransform: "uppercase",
      marginBottom: 6,
    }}>
      {children}
    </div>
  );
}

function formatRelTime(isoTs: string): string {
  const diff = Date.now() - new Date(isoTs).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "justo ahora";
  if (min < 60) return `hace ${min}min`;
  const hr = Math.floor(min / 60);
  return `hace ${hr}h${min % 60 > 0 ? ` ${min % 60}min` : ""}`;
}

export function TanitLearning({ status, apiBase }: { status: TanitLearningData | null; apiBase?: string }) {
  const [open, setOpen] = useState(true);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [multOverrides, setMultOverrides] = useState<Record<string, number>>({});
  const [multLoading, setMultLoading] = useState<Record<string, boolean>>({});
  const [multMsg, setMultMsg] = useState<Record<string, string | null>>({});

  async function handleAdjustMult(sess: string, delta: number, currentMult: number) {
    const param = SESSION_KEY_MAP[sess];
    if (!param) return;
    const newVal = Math.round((currentMult + delta) * 100) / 100;
    if (newVal < 0.70 || newVal > 1.50) return;
    setMultLoading(prev => ({ ...prev, [sess]: true }));
    setMultMsg(prev => ({ ...prev, [sess]: null }));
    setMultOverrides(prev => ({ ...prev, [sess]: newVal }));
    try {
      const base = apiBase ?? "";
      const res = await fetch(`${base}/api/bot/set-session-multiplier`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ param, value: newVal.toFixed(2) }),
      });
      const data = await res.json();
      if (!data.ok) {
        setMultOverrides(prev => ({ ...prev, [sess]: currentMult }));
        setMultMsg(prev => ({ ...prev, [sess]: "❌ Error" }));
      } else {
        setMultMsg(prev => ({ ...prev, [sess]: "✅" }));
      }
    } catch {
      setMultOverrides(prev => ({ ...prev, [sess]: currentMult }));
      setMultMsg(prev => ({ ...prev, [sess]: "❌ Red" }));
    } finally {
      setMultLoading(prev => ({ ...prev, [sess]: false }));
      setTimeout(() => setMultMsg(prev => ({ ...prev, [sess]: null })), 3000);
    }
  }

  async function handleResetMults() {
    setResetLoading(true);
    setResetMsg(null);
    try {
      const base = apiBase ?? "";
      const res = await fetch(`${base}/api/bot/reset-session-multipliers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "reset manual desde dashboard" }),
      });
      const data = await res.json();
      setResetMsg(data.message ?? (data.ok ? "✅ Restablecido" : "❌ Error"));
      if (data.ok) setMultOverrides({});
    } catch {
      setResetMsg("❌ Error de red");
    } finally {
      setResetLoading(false);
      setTimeout(() => setResetMsg(null), 4000);
    }
  }

  const cal        = status?.calibration;
  const thresholds = cal?.sessionThresholds ?? {};
  const bases      = cal?.sessionThresholdBase ?? {};
  const multipliers = cal?.sessionMultipliers ?? {};
  const history    = cal?.history ?? [];
  const symAvoid   = status?.symAvoid ?? [];
  const symBonus   = status?.symBonus ?? {};
  const ddActive   = status?.drawdownActive ?? false;
  const ddBonus    = status?.drawdownBonus ?? 0;
  const ddTrigger  = status?.drawdownTriggerPct ?? 5;
  const cycleCount = cal?.cycleCount ?? 0;
  const swapAdv    = status?.swapMinAdvantage;
  const swapAge    = status?.swapMinAgeMin;
  const swapLoss   = status?.swapMaxLoss;

  const symBonusEntries = Object.entries(symBonus)
    .filter(([, v]) => v !== 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <div style={{
      borderRadius: 16,
      border: "1px solid rgba(167,139,250,0.25)",
      background: "rgba(167,139,250,0.04)",
      overflow: "hidden",
    }}>
      {/* ── Header ── */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px 10px",
          borderBottom: open ? "1px solid rgba(255,255,255,0.07)" : "none",
          background: "none",
          cursor: "pointer",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Dot color={PURPLE} />
          <span style={{
            fontFamily: "var(--app-font-mono)", fontSize: 10,
            fontWeight: 700, letterSpacing: "0.18em", color: PURPLE,
          }}>
            APRENDIZAJE AUTÓNOMO · CICLO {cycleCount}
          </span>
        </div>
        <svg
          width={14} height={14} viewBox="0 0 24 24" fill="none"
          stroke="rgba(255,255,255,0.3)" strokeWidth={2}
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 16 }}>

          {/* ── 0. Multiplicadores de sesión · actual vs default ── */}
          {Object.keys(multipliers).length > 0 && (() => {
            const latestChanges = history[0]?.changes ?? [];
            return (
              <div>
                <SectionLabel>Multiplicadores de sesión · actual vs default</SectionLabel>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                  {SESSION_ORDER.map(sess => {
                    const current  = multOverrides[sess] ?? multipliers[sess];
                    if (current === undefined) return null;
                    const defVal   = SESSION_DEFAULTS[sess] ?? 1.00;
                    const key      = SESSION_KEY_MAP[sess] ?? "";
                    const hours    = SESSION_HOURS[sess] ?? "";
                    const changed  = Math.abs(current - defVal) > 0.001;
                    const changedThisCycle = latestChanges.some(c => c.startsWith(key + ":"));
                    const col      = multColor(current);
                    const diffDir  = current < defVal ? "▼" : current > defVal ? "▲" : "";
                    const diffCol  = current < defVal ? GREEN : current > defVal ? AMBER : "transparent";
                    return (
                      <div key={sess} style={{
                        borderRadius: 9,
                        border: changedThisCycle
                          ? `1px solid ${PURPLE}66`
                          : changed
                            ? `1px solid ${col}44`
                            : "1px solid rgba(255,255,255,0.07)",
                        background: changedThisCycle
                          ? `${PURPLE}10`
                          : changed
                            ? `${col}09`
                            : "rgba(255,255,255,0.02)",
                        padding: "8px 10px",
                        position: "relative",
                      }}>
                        {changedThisCycle && (
                          <div style={{
                            position: "absolute", top: 4, right: 6,
                            fontSize: 7, fontWeight: 700, letterSpacing: "0.1em",
                            color: PURPLE, fontFamily: "var(--app-font-mono)",
                          }}>
                            NUEVO
                          </div>
                        )}
                        <div style={{
                          fontSize: 8, fontWeight: 700, letterSpacing: "0.1em",
                          color: "rgba(255,255,255,0.5)", marginBottom: 5,
                          textTransform: "uppercase",
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        }}>
                          {sess === "London+NY Overlap" ? "LDN+NY" : sess}
                          <span style={{ color: "rgba(255,255,255,0.25)", marginLeft: 4, fontWeight: 400 }}>
                            {hours}
                          </span>
                        </div>
                        <div style={{
                          display: "flex", alignItems: "baseline", gap: 4, marginBottom: 3,
                        }}>
                          <span style={{
                            fontSize: 20, fontWeight: 800,
                            fontFamily: "var(--app-font-mono)",
                            color: col, lineHeight: 1,
                          }}>
                            ×{current.toFixed(2)}
                          </span>
                          {diffDir && (
                            <span style={{ fontSize: 10, color: diffCol, fontWeight: 700 }}>
                              {diffDir}
                            </span>
                          )}
                        </div>
                        <div style={{
                          fontSize: 9, fontFamily: "var(--app-font-mono)",
                          color: "rgba(255,255,255,0.3)",
                        }}>
                          {changed ? (
                            <span>
                              <span style={{ color: "rgba(255,255,255,0.2)" }}>×{defVal.toFixed(2)}</span>
                              <span style={{ margin: "0 3px", color: "rgba(255,255,255,0.2)" }}>→</span>
                              <span style={{ color: col }}>×{current.toFixed(2)}</span>
                            </span>
                          ) : (
                            <span style={{ color: "rgba(255,255,255,0.25)" }}>= default</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Reset button — only shown when any multiplier has drifted */}
                {SESSION_ORDER.some(s => {
                  const cur = multipliers[s];
                  const def = SESSION_DEFAULTS[s] ?? 1.00;
                  return cur !== undefined && Math.abs(cur - def) > 0.001;
                }) && (
                  <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      onClick={handleResetMults}
                      disabled={resetLoading}
                      style={{
                        padding: "5px 12px",
                        borderRadius: 7,
                        border: "1px solid rgba(242,54,69,0.4)",
                        background: "rgba(242,54,69,0.08)",
                        color: "#F23645",
                        fontSize: 9,
                        fontWeight: 700,
                        fontFamily: "var(--app-font-mono)",
                        letterSpacing: "0.12em",
                        cursor: resetLoading ? "not-allowed" : "pointer",
                        opacity: resetLoading ? 0.5 : 1,
                        transition: "opacity 0.2s",
                      }}
                    >
                      {resetLoading ? "RESTABLECIENDO…" : "↺ RESETEAR A DEFAULTS"}
                    </button>
                    {resetMsg && (
                      <span style={{
                        fontSize: 9, fontFamily: "var(--app-font-mono)",
                        color: resetMsg.startsWith("✅") ? GREEN : "#F23645",
                      }}>
                        {resetMsg}
                      </span>
                    )}
                  </div>
                )}
                <div style={{
                  marginTop: 6, display: "flex", gap: 10, alignItems: "center",
                  fontSize: 8, color: "rgba(255,255,255,0.25)", fontFamily: "var(--app-font-mono)",
                }}>
                  <span style={{ color: GREEN }}>×0.85 agresiva</span>
                  <span>·</span>
                  <span style={{ color: "rgba(255,255,255,0.4)" }}>×1.00 neutral</span>
                  <span>·</span>
                  <span style={{ color: AMBER }}>×1.20 conservadora</span>
                  <span>·</span>
                  <span style={{ color: PURPLE }}>NUEVO = cambió en último ciclo</span>
                </div>
              </div>
            );
          })()}

          {/* ── 1. Umbrales de Sesión ── */}
          <div>
            <SectionLabel>Umbrales por sesión · actual vs base</SectionLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {TIER_ORDER.map(tier => {
                const cur  = thresholds[tier] ?? bases[tier] ?? 0;
                const base = bases[tier] ?? cur;
                const diff = cur - base;
                const col  = TIER_COLOR[tier] ?? AMBER;
                return (
                  <div key={tier} style={{
                    flex: "1 1 80px",
                    borderRadius: 10,
                    border: `1px solid ${col}33`,
                    background: `${col}0a`,
                    padding: "8px 10px",
                    minWidth: 80,
                  }}>
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: col, marginBottom: 4 }}>
                      {tier}
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--app-font-mono)", color: "rgba(255,255,255,0.9)", lineHeight: 1 }}>
                      {cur || "—"}
                    </div>
                    <div style={{ fontSize: 9, marginTop: 3, color: diff > 0 ? AMBER : diff < 0 ? GREEN : "rgba(255,255,255,0.3)", fontFamily: "var(--app-font-mono)" }}>
                      base {base}
                      {diff !== 0 && <span style={{ marginLeft: 4 }}>{diff > 0 ? `+${diff}` : diff}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── 2. Umbrales efectivos por sesión de mercado ── */}
          {Object.keys(multipliers).length > 0 && (
            <div>
              <SectionLabel>Umbral efectivo por sesión · base × mult</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {SESSION_ORDER.map(sess => {
                  const serverMult = multipliers[sess];
                  if (serverMult === undefined) return null;
                  const mult = multOverrides[sess] ?? serverMult;
                  const col  = multColor(mult);
                  const isLoading = multLoading[sess] ?? false;
                  const msg = multMsg[sess] ?? null;
                  const canDec = mult - 0.05 >= 0.70;
                  const canInc = mult + 0.05 <= 1.50;
                  const effTiers = [
                    { label: "ELITE",  base: thresholds["ELITE"]  ?? bases["ELITE"]  ?? 58, color: "#FFD700" },
                    { label: "HIGH",   base: thresholds["HIGH"]   ?? bases["HIGH"]   ?? 56, color: GREEN },
                    { label: "MEDIUM", base: thresholds["MEDIUM"] ?? bases["MEDIUM"] ?? 54, color: AMBER },
                    { label: "LOW",    base: thresholds["LOW"]    ?? bases["LOW"]    ?? 53, color: "#94A3B8" },
                    { label: "DEAD",   base: thresholds["DEAD"]   ?? bases["DEAD"]   ?? 52, color: RED },
                  ].map(t => ({ ...t, eff: Math.round(t.base * mult) }));
                  return (
                    <div key={sess} style={{
                      borderRadius: 8,
                      border: `1px solid ${col}22`,
                      background: `${col}06`,
                      padding: "7px 12px",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <div style={{
                          flex: "0 0 100px",
                          fontSize: 10, fontWeight: 700,
                          color: "rgba(255,255,255,0.75)",
                          fontFamily: "var(--app-font-mono)",
                          letterSpacing: "0.04em",
                        }}>
                          {sess}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <button
                            onClick={() => handleAdjustMult(sess, -0.05, mult)}
                            disabled={isLoading || !canDec}
                            title="−0.05 (más agresiva)"
                            style={{
                              width: 22, height: 22, borderRadius: 5,
                              border: `1px solid ${GREEN}55`,
                              background: canDec ? `${GREEN}18` : "rgba(255,255,255,0.04)",
                              color: canDec ? GREEN : "rgba(255,255,255,0.2)",
                              fontSize: 13, fontWeight: 700, lineHeight: 1,
                              cursor: isLoading || !canDec ? "not-allowed" : "pointer",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              flexShrink: 0,
                              padding: 0,
                            }}
                          >
                            −
                          </button>
                          <span style={{
                            fontSize: 13, fontWeight: 800,
                            fontFamily: "var(--app-font-mono)",
                            color: isLoading ? "rgba(255,255,255,0.4)" : col,
                            minWidth: 44, textAlign: "center",
                          }}>
                            ×{mult.toFixed(2)}
                          </span>
                          <button
                            onClick={() => handleAdjustMult(sess, +0.05, mult)}
                            disabled={isLoading || !canInc}
                            title="+0.05 (más conservadora)"
                            style={{
                              width: 22, height: 22, borderRadius: 5,
                              border: `1px solid ${AMBER}55`,
                              background: canInc ? `${AMBER}18` : "rgba(255,255,255,0.04)",
                              color: canInc ? AMBER : "rgba(255,255,255,0.2)",
                              fontSize: 13, fontWeight: 700, lineHeight: 1,
                              cursor: isLoading || !canInc ? "not-allowed" : "pointer",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              flexShrink: 0,
                              padding: 0,
                            }}
                          >
                            +
                          </button>
                          {msg && (
                            <span style={{
                              fontSize: 9, fontFamily: "var(--app-font-mono)",
                              color: msg.startsWith("✅") ? GREEN : RED,
                            }}>
                              {msg}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {effTiers.map(it => (
                          <div key={it.label} style={{
                            flex: 1, textAlign: "center",
                            borderRadius: 5,
                            background: `${it.color}08`,
                            padding: "4px 2px",
                          }}>
                            <div style={{ fontSize: 7, color: it.color, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 2 }}>
                              {it.label}
                            </div>
                            <div style={{ fontSize: 12, fontWeight: 800, fontFamily: "var(--app-font-mono)", color: "rgba(255,255,255,0.9)", lineHeight: 1 }}>
                              {it.eff}
                            </div>
                            <div style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", fontFamily: "var(--app-font-mono)", marginTop: 1 }}>
                              b{it.base}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── 3. Historial de ciclos de auto-evolución ── */}
          <div>
            <SectionLabel>Últimos ciclos de auto-evolución</SectionLabel>
            {history.length === 0 ? (
              <div style={{
                padding: "12px 14px", borderRadius: 10,
                border: "1px dashed rgba(255,255,255,0.1)",
                color: "rgba(255,255,255,0.3)", fontSize: 11, textAlign: "center",
              }}>
                El primer ciclo ocurrirá ~30min tras iniciar el bot
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {history.map((cycle, i) => {
                  const prevCycle = history[i + 1] ?? null;
                  const adjDeltas = prevCycle
                    ? TIER_ORDER.map(tier => {
                        const cur  = cycle.sessionAdjustments?.[tier];
                        const prev = prevCycle.sessionAdjustments?.[tier];
                        if (cur == null || prev == null) return null;
                        const delta = cur - prev;
                        if (Math.abs(delta) < 0.5) return null;
                        return { tier, delta };
                      }).filter(Boolean) as { tier: string; delta: number }[]
                    : [];

                  const hasSnapshot = cycle.sessionAdjustments && Object.keys(cycle.sessionAdjustments).length > 0;

                  return (
                    <div key={i} style={{
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.07)",
                      background: "rgba(255,255,255,0.02)",
                      padding: "8px 12px",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 9, fontWeight: 700, fontFamily: "var(--app-font-mono)", color: PURPLE }}>
                            #{cycle.cycleNumber}
                          </span>
                          <span style={{ fontSize: 9, color: "rgba(255,255,255,0.4)" }}>
                            WR {cycle.recentWinRate.toFixed(0)}% · {cycle.recentTrades} trades
                          </span>
                        </div>
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "var(--app-font-mono)" }}>
                          {cycle.ts ? formatRelTime(cycle.ts) : "—"}
                        </span>
                      </div>

                      {/* Threshold snapshot row */}
                      {hasSnapshot && (
                        <div style={{
                          display: "flex", gap: 4, marginBottom: 6,
                          padding: "5px 8px", borderRadius: 7,
                          background: "rgba(255,255,255,0.03)",
                          border: "1px solid rgba(255,255,255,0.05)",
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}>
                          {TIER_ORDER.filter(t => cycle.sessionAdjustments?.[t] != null).map(tier => {
                            const val   = cycle.sessionAdjustments[tier];
                            const col   = TIER_COLOR[tier] ?? AMBER;
                            const delta = adjDeltas.find(d => d.tier === tier);
                            return (
                              <div key={tier} style={{
                                display: "flex", alignItems: "center", gap: 3,
                                padding: "2px 6px", borderRadius: 5,
                                background: delta ? (delta.delta > 0 ? "rgba(255,149,0,0.10)" : "rgba(0,212,170,0.10)") : `${col}08`,
                                border: delta ? (delta.delta > 0 ? "1px solid rgba(255,149,0,0.3)" : "1px solid rgba(0,212,170,0.3)") : `1px solid ${col}20`,
                              }}>
                                <span style={{ fontSize: 8, fontWeight: 700, color: col, letterSpacing: "0.08em" }}>
                                  {tier}
                                </span>
                                <span style={{ fontSize: 10, fontWeight: 800, fontFamily: "var(--app-font-mono)", color: "rgba(255,255,255,0.85)" }}>
                                  {val}
                                </span>
                                {delta && (
                                  <span style={{
                                    fontSize: 8, fontWeight: 700, fontFamily: "var(--app-font-mono)",
                                    color: delta.delta > 0 ? AMBER : GREEN,
                                  }}>
                                    {delta.delta > 0 ? `+${delta.delta}` : delta.delta}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                          {prevCycle == null && (
                            <span style={{ fontSize: 8, color: "rgba(255,255,255,0.2)", fontFamily: "var(--app-font-mono)", marginLeft: 2 }}>
                              base
                            </span>
                          )}
                        </div>
                      )}

                      {cycle.changes.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {cycle.changes.map((c, j) => (
                            <span key={j} style={{
                              fontSize: 9, padding: "2px 7px", borderRadius: 5,
                              background: "rgba(167,139,250,0.12)",
                              border: "1px solid rgba(167,139,250,0.2)",
                              color: "rgba(255,255,255,0.7)",
                            }}>
                              {c}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>
                          Sin cambios — umbrales estables
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {history.length > 1 && (
              <div style={{
                marginTop: 6, fontSize: 8,
                color: "rgba(255,255,255,0.22)", fontFamily: "var(--app-font-mono)",
                display: "flex", gap: 10, alignItems: "center",
                flexWrap: "wrap",
              }}>
                <span style={{ color: GREEN }}>−N = umbral más exigente</span>
                <span>·</span>
                <span style={{ color: AMBER }}>+N = umbral más permisivo</span>
                <span>·</span>
                <span>Δ vs ciclo anterior</span>
              </div>
            )}
          </div>

          {/* ── 3. Símbolos sym_avoid y sym_bonus ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {/* sym_avoid */}
            <div>
              <SectionLabel>sym_avoid activos</SectionLabel>
              {symAvoid.length === 0 ? (
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", padding: "6px 0" }}>
                  Ninguno
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {symAvoid.map((s) => (
                    <Badge key={s} color={RED}>
                      ✕ {s.replace("USDT", "")}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* sym_bonus */}
            <div>
              <SectionLabel>sym_bonus activos</SectionLabel>
              {symBonusEntries.length === 0 ? (
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", padding: "6px 0" }}>
                  Ninguno
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {symBonusEntries.map(([sym, val]) => (
                    <Badge key={sym} color={val > 0 ? GREEN : RED}>
                      {sym.replace("USDT", "")} {val > 0 ? `+${val}` : val}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Agresividad de swap ── */}
          <div>
            <SectionLabel>Agresividad de swap · evolvable</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {[
                { label: "MIN ADVANTAGE", val: swapAdv != null ? swapAdv.toFixed(0) : "—", unit: "pts", hint: "ventaja mín. del candidato" },
                { label: "MIN AGE",       val: swapAge != null ? swapAge.toFixed(0) : "—", unit: "min", hint: "edad mín. para swapear" },
                { label: "MAX LOSS",      val: swapLoss != null ? `$${swapLoss.toFixed(2)}` : "—", unit: "",    hint: "pérdida máx. permitida" },
              ].map((it) => (
                <div key={it.label} style={{
                  borderRadius: 10,
                  border: `1px solid ${PURPLE}33`,
                  background: `${PURPLE}0a`,
                  padding: "8px 10px",
                }}>
                  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: PURPLE, marginBottom: 4 }}>
                    {it.label}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "var(--app-font-mono)", color: "rgba(255,255,255,0.9)", lineHeight: 1 }}>
                    {it.val}{it.unit && <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginLeft: 3 }}>{it.unit}</span>}
                  </div>
                  <div style={{ fontSize: 9, marginTop: 3, color: "rgba(255,255,255,0.35)" }}>
                    {it.hint}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── 4. Drawdown protection ── */}
          <div>
            <SectionLabel>Drawdown protection</SectionLabel>
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              borderRadius: 10,
              border: `1px solid ${ddActive ? RED + "55" : "rgba(255,255,255,0.08)"}`,
              background: ddActive ? "rgba(242,54,69,0.07)" : "rgba(255,255,255,0.02)",
              padding: "10px 14px",
            }}>
              <Dot color={ddActive ? RED : "rgba(255,255,255,0.2)"} />
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 11, fontWeight: 700,
                  color: ddActive ? RED : "rgba(255,255,255,0.4)",
                  marginBottom: 2,
                }}>
                  {ddActive ? "PROTECCIÓN ACTIVA" : "Inactiva"}
                </div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.4)" }}>
                  Disparo: pérdida ≥{ddTrigger}% en ventana reciente
                  {ddActive && ddBonus > 0 && (
                    <span style={{ color: AMBER, marginLeft: 6 }}>
                      · Umbral +{ddBonus}pts
                    </span>
                  )}
                </div>
              </div>
              {ddActive && (
                <Badge color={RED}>
                  +{ddBonus}pts
                </Badge>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
