import { useState, useEffect, useRef } from "react";
import { Layout } from "@/components/layout";
import { BASE_URL } from "@/lib/api";
import { useBotStatus } from "@/contexts/TradingModeContext";

const TEAL  = "#00E5CC";
const RED   = "#E879A0";
const AMBER = "#FF9500";
const WHITE = "#FFFFFF";
const DIM   = "#8894b0";
const CARD  = "#081018";
const LINE  = "#122030";
const DEEP  = "#050c14";

const Label = ({ children, color = DIM }: { children: React.ReactNode; color?: string }) => (
  <div style={{
    fontFamily: "var(--app-font-mono, monospace)",
    fontSize: 9, letterSpacing: "0.18em",
    textTransform: "uppercase" as const,
    color, fontWeight: 600,
  }}>{children}</div>
);

const Val = ({ children, color = WHITE, size = 22 }: { children: React.ReactNode; color?: string; size?: number }) => (
  <div style={{ fontFamily: "var(--app-font-sans)", fontWeight: 800, fontSize: size, color, letterSpacing: "-0.5px" }}>
    {children}
  </div>
);

export default function Live() {
  const { bot, isLive: globalIsLive, refresh } = useBotStatus();

  const [preflight, setPreflight]       = useState<any>(null);
  const [loadingPreflight, setLoading]  = useState(false);
  const [dailyLimit, setDailyLimit]     = useState(20);
  const [savingLimit, setSavingLimit]   = useState(false);
  const [killing, setKilling]           = useState(false);
  const [killResult, setKillResult]     = useState<any>(null);
  const [showKillConfirm, setShowKill]  = useState(false);
  const [showLiveConfirm, setShowLive]  = useState(false);
  const [toggling, setToggling]         = useState(false);
  const [togglingTestnet, setTogglingTestnet] = useState(false);
  const [configuringSmall, setConfiguringSmall] = useState(false);
  const [smallConfigApplied, setSmallConfigApplied] = useState(false);

  const preflightRanRef = useRef(false);

  // Sincronizar límite diario desde el contexto global
  useEffect(() => {
    if (bot?.dailyLossLimitPct) setDailyLimit(bot.dailyLossLimitPct);
  }, [bot?.dailyLossLimitPct]);

  // Auto-verificar preflight si el bot ya está en modo real
  useEffect(() => {
    if (bot?.liveMode && !preflightRanRef.current) {
      preflightRanRef.current = true;
      fetch(`${BASE_URL}api/bot/preflight`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) setPreflight(d); })
        .catch(() => {});
    }
  }, [bot?.liveMode]);

  const runPreflight = async () => {
    setLoading(true);
    setPreflight(null);
    try {
      const r = await fetch(`${BASE_URL}api/bot/preflight`);
      if (r.ok) setPreflight(await r.json());
    } catch {} finally { setLoading(false); }
  };

  const saveDailyLimit = async (pct: number) => {
    setSavingLimit(true);
    try {
      await fetch(`${BASE_URL}api/bot/daily-limit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pct }),
      });
    } catch {} finally { setSavingLimit(false); }
  };

  const handleKill = async () => {
    setKilling(true);
    setShowKill(false);
    try {
      const r = await fetch(`${BASE_URL}api/bot/kill`, { method: "POST" });
      if (r.ok) {
        const d = await r.json();
        setKillResult(d);
        refresh();
      }
    } catch {} finally { setKilling(false); }
  };

  const applySmallAccountConfig = async () => {
    setConfiguringSmall(true);
    try {
      const balance = preflight?.balance ?? liveBalance;
      await fetch(`${BASE_URL}api/bot/configure-small-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ balance }),
      });
      setSmallConfigApplied(true);
      // Re-run preflight after configuring
      await new Promise(r => setTimeout(r, 600));
      const r = await fetch(`${BASE_URL}api/bot/preflight`);
      if (r.ok) setPreflight(await r.json());
    } catch {} finally { setConfiguringSmall(false); }
  };

  const switchToMainnet = async () => {
    setTogglingTestnet(true);
    try {
      await fetch(`${BASE_URL}api/bot/testnet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testnet: false }),
      });
      // Re-run preflight after switching
      await new Promise(r => setTimeout(r, 600));
      const r = await fetch(`${BASE_URL}api/bot/preflight`);
      if (r.ok) setPreflight(await r.json());
    } catch {} finally { setTogglingTestnet(false); }
  };

  const [toggleError, setToggleError] = useState<string | null>(null);

  const handleToggleLive = async (goLive: boolean) => {
    setToggling(true);
    setShowLive(false);
    setToggleError(null);
    try {
      if (goLive) {
        const r = await fetch(`${BASE_URL}api/bot/settings`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ liveMode: true }),
        });
        if (!r.ok) throw new Error(`Error del servidor: ${r.status}`);
        await new Promise(r => setTimeout(r, 400));
      } else {
        const isRunning = bot?.active || bot?.mpActive;
        if (isRunning) {
          const r1 = await fetch(`${BASE_URL}api/bot/toggle`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active: false }),
          });
          if (!r1.ok) throw new Error(`Error deteniendo bot: ${r1.status}`);
          await new Promise(r => setTimeout(r, 600));
        }
        const r2 = await fetch(`${BASE_URL}api/bot/settings`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ liveMode: false }),
        });
        if (!r2.ok) throw new Error(`Error cambiando modo: ${r2.status}`);
      }
      await new Promise(r => setTimeout(r, 400));
      refresh();
    } catch (e: any) {
      setToggleError(e?.message ?? "Error al cambiar modo");
    } finally { setToggling(false); }
  };

  const isLive      = globalIsLive;
  const isRunning   = bot?.active || bot?.mpActive;
  const liveBalance = bot?.liveBalance;
  const dailyPnl    = bot?.dailyPnl ?? 0;
  const dailyStart  = bot?.dailyStartBalance ?? 0;
  const openCount   = Object.keys(bot?.openPositions ?? {}).length;

  return (
    <Layout>
      <div style={{ maxWidth: 480, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* ── TÍTULO ─────────────────────────────────────────────────────── */}
        <div style={{ paddingBottom: 4 }}>
          <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, letterSpacing: "0.2em", color: DIM, marginBottom: 4 }}>MODO REAL</div>
          <div style={{ fontFamily: "var(--app-font-sans)", fontWeight: 800, fontSize: 24, color: WHITE, letterSpacing: "-0.5px" }}>
            Dinero Real
          </div>
          <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: DIM, marginTop: 4 }}>
            Bybit Mainnet · UID 555753345
          </div>
        </div>

        {/* ── BANNER: Estado actual ───────────────────────────────────────── */}
        <div style={{
          borderRadius: 16, padding: "16px 18px",
          background: isLive
            ? "linear-gradient(135deg, rgba(232,121,160,0.10) 0%, rgba(8,12,20,0.95) 100%)"
            : "linear-gradient(135deg, rgba(0,229,204,0.04) 0%, rgba(8,12,20,0.92) 100%)",
          border: `1px solid ${isLive ? "rgba(232,121,160,0.3)" : "rgba(0,229,204,0.12)"}`,
          boxShadow: isLive ? "0 0 40px rgba(232,121,160,0.08) inset" : "none",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 10, height: 10, borderRadius: "50%",
                background: isLive ? RED : "rgba(255,255,255,0.15)",
                boxShadow: isLive ? `0 0 14px ${RED}` : "none",
              }} />
              <div>
                <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, fontWeight: 700,
                  color: isLive ? RED : "rgba(136,180,200,0.6)", letterSpacing: "0.15em" }}>
                  {isLive ? "MODO REAL ACTIVO" : "PAPER TRADING"}
                </div>
                {isLive && liveBalance != null && (
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>
                    Balance Bybit: ${liveBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} USDT
                  </div>
                )}
              </div>
            </div>
            {isLive && (
              <div style={{
                fontFamily: "var(--app-font-mono)", fontSize: 8, fontWeight: 700,
                color: RED, background: "rgba(232,121,160,0.1)",
                border: "1px solid rgba(232,121,160,0.2)",
                padding: "4px 10px", borderRadius: 6, letterSpacing: "0.12em",
              }}>LIVE</div>
            )}
          </div>

          {/* Daily PnL */}
          {isLive && dailyStart > 0 && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid rgba(255,255,255,0.05)`,
              display: "flex", gap: 20 }}>
              {[
                { l: "PnL HOY", v: (dailyPnl >= 0 ? "+" : "") + "$" + Math.abs(dailyPnl).toFixed(2), c: dailyPnl >= 0 ? TEAL : RED },
                { l: "POSICIONES", v: String(openCount), c: openCount > 0 ? AMBER : "rgba(255,255,255,0.4)" },
                { l: "LÍMITE CICLO", v: `-${bot?.dailyLossLimitPct ?? 20}%`, c: "rgba(255,255,255,0.5)" },
              ].map(item => (
                <div key={item.l}>
                  <Label color="rgba(136,180,200,0.5)">{item.l}</Label>
                  <Val color={item.c} size={16}>{item.v}</Val>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── PREFLIGHT CHECKLIST ─────────────────────────────────────────── */}
        <div style={{ background: CARD, borderRadius: 16, padding: "16px 18px", border: `1px solid ${LINE}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <Label>VERIFICACIÓN PRE-VUELO</Label>
            <button onClick={runPreflight} disabled={loadingPreflight} style={{
              fontFamily: "var(--app-font-mono)", fontSize: 9, letterSpacing: "0.12em",
              padding: "5px 14px", borderRadius: 8,
              background: loadingPreflight ? "rgba(0,229,204,0.05)" : "rgba(0,229,204,0.08)",
              border: "1px solid rgba(0,229,204,0.2)", color: TEAL,
              cursor: loadingPreflight ? "not-allowed" : "pointer",
            }}>
              {loadingPreflight ? "VERIFICANDO..." : "VERIFICAR"}
            </button>
          </div>

          {!preflight && !loadingPreflight && (
            <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: "rgba(136,180,200,0.4)", textAlign: "center", padding: "12px 0" }}>
              Presiona VERIFICAR antes de activar dinero real
            </div>
          )}

          {loadingPreflight && (
            <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: TEAL, textAlign: "center", padding: "12px 0" }}>
              Conectando con Bybit...
            </div>
          )}

          {preflight && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {preflight.checks.map((c: any, i: number) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 12px", borderRadius: 10,
                  background: c.ok ? "rgba(0,229,204,0.04)" : "rgba(232,121,160,0.04)",
                  border: `1px solid ${c.ok ? "rgba(0,229,204,0.12)" : "rgba(232,121,160,0.15)"}`,
                }}>
                  <div style={{ fontSize: 16, flexShrink: 0 }}>{c.ok ? "✅" : "❌"}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, fontWeight: 700, color: c.ok ? TEAL : RED }}>{c.label}</div>
                    <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM, marginTop: 2 }}>{c.detail}</div>
                  </div>
                  {/* Acción rápida: cambiar a mainnet */}
                  {!c.ok && c.label.toLowerCase().includes("mainnet") && (
                    <button
                      onClick={switchToMainnet}
                      disabled={togglingTestnet}
                      style={{
                        flexShrink: 0,
                        fontFamily: "var(--app-font-mono)", fontSize: 8, fontWeight: 700,
                        letterSpacing: "0.08em", padding: "5px 10px", borderRadius: 6,
                        background: togglingTestnet ? "rgba(0,229,204,0.04)" : "rgba(0,229,204,0.10)",
                        border: "1px solid rgba(0,229,204,0.25)", color: TEAL,
                        cursor: togglingTestnet ? "not-allowed" : "pointer",
                        whiteSpace: "nowrap" as const,
                      }}>
                      {togglingTestnet ? "..." : "→ MAINNET"}
                    </button>
                  )}
                </div>
              ))}

              {/* Resultado global */}
              <div style={{
                marginTop: 4, padding: "10px 12px", borderRadius: 10, textAlign: "center",
                background: preflight.ok ? "rgba(0,229,204,0.06)" : "rgba(232,121,160,0.06)",
                border: `1px solid ${preflight.ok ? "rgba(0,229,204,0.2)" : "rgba(232,121,160,0.2)"}`,
              }}>
                <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, fontWeight: 700,
                  color: preflight.ok ? TEAL : RED }}>
                  {preflight.ok ? "✅ LISTO PARA OPERAR EN REAL" : "❌ RESOLVER PROBLEMAS ANTES DE CONTINUAR"}
                </div>
              </div>

              {preflight.ok && !isLive && (
                <button
                  onClick={() => setShowLive(true)}
                  disabled={toggling}
                  style={{
                    marginTop: 8, width: "100%", padding: "16px",
                    borderRadius: 12, border: "none",
                    fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 13, letterSpacing: "0.1em",
                    background: `linear-gradient(135deg, ${RED}, #c02020)`,
                    color: WHITE, cursor: toggling ? "not-allowed" : "pointer",
                    opacity: toggling ? 0.6 : 1,
                    boxShadow: "0 4px 24px rgba(232,121,160,0.35)",
                  }}>
                  {toggling ? "ACTIVANDO..." : "⚡ ACTIVAR DINERO REAL"}
                </button>
              )}
              {preflight.ok && isLive && (
                <div style={{
                  marginTop: 8, padding: "12px", borderRadius: 10, textAlign: "center",
                  background: "rgba(232,121,160,0.08)", border: "1px solid rgba(232,121,160,0.25)",
                }}>
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, fontWeight: 700, color: RED, letterSpacing: "0.12em" }}>
                    🔴 MODO REAL ACTIVO
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── LÍMITE DE PÉRDIDA POR CICLO ─────────────────────────────────── */}
        <div style={{ background: CARD, borderRadius: 16, padding: "16px 18px", border: `1px solid ${LINE}` }}>
          <Label>LÍMITE DE PÉRDIDA POR CICLO</Label>
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontFamily: "var(--app-font-sans)", fontSize: 28, fontWeight: 800, color: RED }}>
                -{dailyLimit}%
              </div>
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM, textAlign: "right", lineHeight: 1.5 }}>
                Si la pérdida del ciclo<br />supera este límite,<br />el bot para solo
              </div>
            </div>

            <input
              type="range" min={1} max={20} step={1} value={dailyLimit}
              onChange={e => setDailyLimit(Number(e.target.value))}
              onMouseUp={() => saveDailyLimit(dailyLimit)}
              onTouchEnd={() => saveDailyLimit(dailyLimit)}
              style={{ width: "100%", accentColor: RED, cursor: "pointer" }}
            />

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              {[1, 5, 8, 10, 12, 15, 18, 20].map(v => (
                <div key={v}
                  onClick={() => { setDailyLimit(v); saveDailyLimit(v); }}
                  style={{
                    fontFamily: "var(--app-font-mono)", fontSize: 8, cursor: "pointer",
                    color: dailyLimit === v ? RED : "rgba(255,255,255,0.2)", fontWeight: dailyLimit === v ? 800 : 400,
                  }}>
                  {v}%
                </div>
              ))}
            </div>

            {savingLimit && (
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: TEAL, textAlign: "center", marginTop: 6 }}>
                Guardando...
              </div>
            )}
          </div>
        </div>

        {/* ── ACTIVAR / DESACTIVAR MODO REAL ──────────────────────────────── */}
        <div style={{ background: CARD, borderRadius: 16, padding: "16px 18px", border: `1px solid ${LINE}` }}>
          <Label>OPERAR CON DINERO REAL</Label>
          <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM, marginTop: 6, marginBottom: 14, lineHeight: 1.6 }}>
            Activa el modo real solo cuando el preflight muestre todo en verde.<br />
            Las órdenes van directamente a tu cuenta de Bybit.
          </div>

          {isLive ? (
            <button onClick={() => handleToggleLive(false)} disabled={toggling} style={{
              width: "100%", padding: "16px",
              borderRadius: 12, border: "1px solid rgba(136,180,200,0.15)",
              fontFamily: "var(--app-font-mono)", fontWeight: 700, fontSize: 12, letterSpacing: "0.08em",
              background: "rgba(136,180,200,0.06)", color: DIM,
              cursor: toggling ? "not-allowed" : "pointer", opacity: toggling ? 0.6 : 1,
            }}>
              {toggling ? "..." : "VOLVER A PAPER TRADING"}
            </button>
          ) : (
            <button
              onClick={() => setShowLive(true)}
              disabled={toggling || !(preflight?.ok)}
              style={{
                width: "100%", padding: "16px",
                borderRadius: 12, border: "none",
                fontFamily: "var(--app-font-mono)", fontWeight: 700, fontSize: 12, letterSpacing: "0.08em",
                background: preflight?.ok
                  ? `linear-gradient(135deg, ${RED}, #c02020)`
                  : "rgba(136,180,200,0.06)",
                color: preflight?.ok ? WHITE : "rgba(136,180,200,0.3)",
                cursor: preflight?.ok ? "pointer" : "not-allowed",
                opacity: toggling ? 0.6 : 1,
                boxShadow: preflight?.ok ? "0 4px 20px rgba(232,121,160,0.3)" : "none",
              }}>
              {toggling ? "..." : "ACTIVAR DINERO REAL"}
            </button>
          )}

          {!preflight?.ok && !isLive && (
            <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: "rgba(136,180,200,0.4)", textAlign: "center", marginTop: 8 }}>
              Completa la verificación pre-vuelo primero
            </div>
          )}

          {toggleError && (
            <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: RED, textAlign: "center", marginTop: 8, padding: "8px 12px", borderRadius: 8, background: "rgba(232,121,160,0.08)", border: "1px solid rgba(232,121,160,0.2)" }}>
              {toggleError}
            </div>
          )}
        </div>

        {/* ── EMERGENCY KILL SWITCH ────────────────────────────────────────── */}
        <div style={{
          background: "rgba(232,121,160,0.04)",
          borderRadius: 16, padding: "16px 18px",
          border: "1px solid rgba(232,121,160,0.15)",
        }}>
          <Label color="rgba(232,121,160,0.6)">KILL SWITCH DE EMERGENCIA</Label>
          <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 9, color: DIM, marginTop: 6, marginBottom: 14, lineHeight: 1.6 }}>
            Cierra TODAS las posiciones abiertas y detiene el bot completamente.<br />
            Úsalo solo en emergencias. Las órdenes se envían a mercado.
          </div>

          {killResult && (
            <div style={{
              marginBottom: 12, padding: "10px 12px", borderRadius: 10,
              background: "rgba(0,229,204,0.04)", border: "1px solid rgba(0,229,204,0.15)",
            }}>
              <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: TEAL }}>
                Kill ejecutado: {killResult.closed?.length ?? 0} cerradas
                {killResult.errors?.length > 0 && ` | ${killResult.errors.length} errores`}
              </div>
            </div>
          )}

          <button
            onClick={() => setShowKill(true)}
            disabled={killing}
            style={{
              width: "100%", padding: "16px",
              borderRadius: 12, border: "2px solid rgba(232,121,160,0.4)",
              fontFamily: "var(--app-font-mono)", fontWeight: 800, fontSize: 13, letterSpacing: "0.1em",
              background: killing ? "rgba(232,121,160,0.08)" : "rgba(232,121,160,0.12)",
              color: killing ? "rgba(232,121,160,0.5)" : RED,
              cursor: killing ? "not-allowed" : "pointer",
            }}>
            {killing ? "CERRANDO POSICIONES..." : "⛔ KILL — CERRAR TODO"}
          </button>
        </div>

        {/* ── MODAL: Confirmar Live ───────────────────────────────────────── */}
        {showLiveConfirm && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center",
            padding: "0 20px", background: "rgba(0,0,0,0.92)",
          }} onClick={() => setShowLive(false)}>
            <div style={{
              width: "100%", maxWidth: 380, borderRadius: 20, padding: "28px 24px",
              background: "linear-gradient(160deg, #180808 0%, #0a0406 100%)",
              border: "1px solid rgba(232,121,160,0.3)",
            }} onClick={e => e.stopPropagation()}>
              <div style={{ textAlign: "center", marginBottom: 24 }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>🔴</div>
                <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, letterSpacing: "0.2em", color: RED, marginBottom: 10, fontWeight: 700 }}>
                  ACTIVAR DINERO REAL
                </div>
                <div style={{ fontFamily: "var(--app-font-sans)", fontWeight: 800, fontSize: 20, color: WHITE, marginBottom: 12 }}>
                  ¿Operar con dinero real?
                </div>
                {preflight?.balance != null && (
                  <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 13, color: TEAL, fontWeight: 700, marginBottom: 8 }}>
                    Balance: ${preflight.balance.toFixed(2)} USDT
                  </div>
                )}
                <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 10, color: DIM, lineHeight: 1.7 }}>
                  El sistema cambiará a Bybit Mainnet.<br />
                  Todas las operaciones usarán tu cuenta real.<br />
                  Límite de pérdida del ciclo: <span style={{ color: RED, fontWeight: 700 }}>-{dailyLimit}%</span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <button onClick={() => setShowLive(false)} style={{
                  padding: "14px", borderRadius: 12, fontFamily: "var(--app-font-mono)",
                  fontWeight: 700, fontSize: 12, letterSpacing: "0.08em",
                  background: DEEP, color: DIM, border: `1px solid ${LINE}`, cursor: "pointer",
                }}>CANCELAR</button>
                <button onClick={() => handleToggleLive(true)} style={{
                  padding: "14px", borderRadius: 12, fontFamily: "var(--app-font-mono)",
                  fontWeight: 700, fontSize: 12, letterSpacing: "0.08em",
                  background: RED, color: WHITE, border: "none", cursor: "pointer",
                }}>CONFIRMAR</button>
              </div>
            </div>
          </div>
        )}

        {/* ── MODAL: Confirmar Kill ────────────────────────────────────────── */}
        {showKillConfirm && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center",
            padding: "0 20px", background: "rgba(0,0,0,0.95)",
          }} onClick={() => setShowKill(false)}>
            <div style={{
              width: "100%", maxWidth: 380, borderRadius: 20, padding: "28px 24px",
              background: "linear-gradient(160deg, #180808 0%, #0a0406 100%)",
              border: "1px solid rgba(232,121,160,0.4)",
            }} onClick={e => e.stopPropagation()}>
              <div style={{ textAlign: "center", marginBottom: 24 }}>
                <div style={{ fontSize: 48, marginBottom: 8 }}>⛔</div>
                <div style={{ fontFamily: "var(--app-font-sans)", fontWeight: 800, fontSize: 20, color: WHITE, marginBottom: 12 }}>
                  Kill Switch
                </div>
                <div style={{ fontFamily: "var(--app-font-mono)", fontSize: 11, color: DIM, lineHeight: 1.7 }}>
                  Cerrará {openCount > 0 ? `${openCount} posición${openCount > 1 ? "es" : ""} abierta${openCount > 1 ? "s" : ""}` : "todas las posiciones"} a precio de mercado y detendrá el bot.
                  {openCount === 0 && " No hay posiciones abiertas en este momento."}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <button onClick={() => setShowKill(false)} style={{
                  padding: "14px", borderRadius: 12, fontFamily: "var(--app-font-mono)",
                  fontWeight: 700, fontSize: 12, background: DEEP, color: DIM, border: `1px solid ${LINE}`, cursor: "pointer",
                }}>CANCELAR</button>
                <button onClick={handleKill} style={{
                  padding: "14px", borderRadius: 12, fontFamily: "var(--app-font-mono)",
                  fontWeight: 800, fontSize: 12, letterSpacing: "0.06em",
                  background: RED, color: WHITE, border: "none", cursor: "pointer",
                }}>EJECUTAR KILL</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </Layout>
  );
}
