import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useTheme } from "@/contexts/ThemeContext";
import { useBotStatus } from "@/contexts/TradingModeContext";
import { BASE_URL } from "@/lib/api";
import {
  AllLogoIcon, M2MLogoFull, PanelIcon, HistorialIcon,
  CurveIcon, RiskShieldIcon,
} from "./Icons";
import { TanitChat } from "./TanitChat";
import { TickerStrip } from "./TickerStrip";

const NAV = [
  { href: "/panel",     Icon: PanelIcon,      label: "Panel"     },
  { href: "/historial", Icon: HistorialIcon,   label: "Historial" },
  { href: "/curva",     Icon: CurveIcon,       label: "Curva"     },
  { href: "/live",      Icon: RiskShieldIcon,  label: "Real"      },
];

const PAGE_TITLES: Record<string, string> = {
  "/panel":     "Panel de Control",
  "/historial": "Historial de Trades",
  "/curva":     "Curva de Capital",
  "/live":      "Modo Real · Bybit",
  "/dashboard": "Terminal",
};

const TEAL   = "#00D4B4";
const AMBER  = "#F5A623";

export function Layout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { theme, toggle } = useTheme();
  const { bot, isLive, refresh } = useBotStatus();
  const [showModeConfirm, setShowModeConfirm] = useState(false);
  const [switching, setSwitching] = useState(false);

  const switchToPaper = async () => {
    setSwitching(true);
    try {
      if (bot?.active || bot?.mpActive) {
        await fetch(`${BASE_URL}api/bot/toggle`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: false }),
        });
        await new Promise(r => setTimeout(r, 600));
      }
      await fetch(`${BASE_URL}api/bot/settings`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveMode: false }),
      });
      await refresh();
    } catch {} finally { setSwitching(false); setShowModeConfirm(false); }
  };

  const handleModeBadgeClick = () => {
    if (isLive) setShowModeConfirm(true);
    else navigate("/live");
  };

  const hybrid  = bot?.hybrid ?? null;
  const regime  = hybrid?.regime ?? null;
  const balance = bot?.liveBalance ?? 0;

  const currentTitle = Object.entries(PAGE_TITLES)
    .find(([k]) => location.startsWith(k))?.[1] ?? "M2M";

  const regimeColor = regime === "trending" ? TEAL
    : regime === "lateral" ? "#7090ff"
    : "#FF9500";
  const regimeLabel = regime === "trending" ? "TRENDING"
    : regime === "lateral" ? "LATERAL"
    : regime ? "TRANSICIÓN" : "HYBRID";

  return (
    <div
      className="min-h-screen flex"
      style={{ background: "var(--m2m-bg)", fontFamily: "var(--app-font-sans)" }}
    >
      {/* ══════════════════════════════════════════════════════════
          DESKTOP SIDEBAR — 220px, clean navy, Bybit-style
      ══════════════════════════════════════════════════════════ */}
      <aside className="hidden md:flex flex-col w-[220px] shrink-0 h-screen sticky top-0 premium-sidebar">

        {/* Logo block */}
        <div style={{
          padding: "20px 20px 16px",
          borderBottom: "1px solid var(--m2m-border)",
        }}>
          <div className="m2m-logo-entrance">
            <M2MLogoFull size={32} />
          </div>
          <div style={{ marginTop: 6 }}>
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: "0.22em",
              color: "rgba(0,212,180,0.5)", fontFamily: "var(--app-font-mono)",
              textTransform: "uppercase",
            }}>Money Maker</div>
            <div style={{
              fontSize: 8, fontWeight: 400, letterSpacing: "0.18em",
              color: "rgba(255,255,255,0.18)", fontFamily: "var(--app-font-mono)",
              marginTop: 2,
            }}>IA Trading · Hybrid Engine</div>
          </div>
        </div>

        {/* Section label */}
        <div style={{
          padding: "14px 20px 8px",
          fontSize: 9, fontWeight: 700, letterSpacing: "0.18em",
          color: "rgba(255,255,255,0.2)", fontFamily: "var(--app-font-mono)",
        }}>
          NAVEGACIÓN
        </div>

        {/* Nav links */}
        <nav style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
          {NAV.map(({ href, Icon, label }) => {
            const active = location.startsWith(href);
            const isReal = href === "/live";
            const ac = isReal ? AMBER : TEAL;
            return (
              <Link key={href} href={href} style={{ textDecoration: "none", display: "block" }}>
                <div className={`flex items-center gap-3 ${active ? "nav-active" : ""}`}
                  style={{
                    padding: "9px 12px",
                    borderRadius: 6,
                    marginBottom: 2,
                    color: active ? ac : "rgba(255,255,255,0.42)",
                    fontSize: 13,
                    fontWeight: active ? 600 : 400,
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  <Icon size={15} color={active ? ac : "rgba(255,255,255,0.28)"} />
                  <span>{label}</span>
                  {isReal && isLive && (
                    <span style={{
                      marginLeft: "auto",
                      width: 6, height: 6, borderRadius: "50%",
                      background: AMBER,
                      boxShadow: `0 0 6px ${AMBER}`,
                      flexShrink: 0,
                    }} />
                  )}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Section label */}
        <div style={{
          padding: "14px 20px 8px",
          fontSize: 9, fontWeight: 700, letterSpacing: "0.18em",
          color: "rgba(255,255,255,0.2)", fontFamily: "var(--app-font-mono)",
          borderTop: "1px solid var(--m2m-border)",
        }}>
          TANIT · AI STATUS
        </div>

        {/* AI Status block */}
        <div style={{ padding: "0 16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>

          {/* Mode indicator */}
          <div style={{
            background: isLive ? "rgba(245,166,35,0.07)" : "rgba(0,212,180,0.06)",
            border: `1px solid ${isLive ? "rgba(245,166,35,0.18)" : "rgba(0,212,180,0.14)"}`,
            borderRadius: 6,
            padding: "8px 12px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
              <div style={{
                width: 6, height: 6, borderRadius: "50%",
                background: isLive ? AMBER : TEAL,
                boxShadow: `0 0 6px ${isLive ? AMBER : TEAL}`,
                flexShrink: 0,
              }} />
              <span style={{
                fontFamily: "var(--app-font-mono)", fontSize: 9,
                fontWeight: 700, letterSpacing: "0.10em",
                color: isLive ? AMBER : TEAL,
              }}>
                {isLive ? "MODO REAL" : "MODO PAPER"}
              </span>
            </div>
            {isLive && (
              <div style={{
                fontFamily: "var(--app-font-mono)", fontSize: 11,
                fontWeight: 700, color: "#fff",
              }}>
                ${balance.toFixed(2)}
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontWeight: 400, marginLeft: 4 }}>USDT</span>
              </div>
            )}
          </div>

          {/* Regime */}
          <div style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px solid var(--m2m-border)",
            borderRadius: 6,
            padding: "7px 12px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <span style={{
              fontFamily: "var(--app-font-mono)", fontSize: 9,
              color: "rgba(255,255,255,0.28)", letterSpacing: "0.08em",
            }}>RÉGIMEN</span>
            <span style={{
              fontFamily: "var(--app-font-mono)", fontSize: 9,
              fontWeight: 700, color: regimeColor, letterSpacing: "0.06em",
            }}>{regimeLabel}</span>
          </div>

          {/* Bybit tag */}
          <div style={{
            fontFamily: "var(--app-font-mono)", fontSize: 9,
            color: "rgba(255,255,255,0.18)", textAlign: "center",
            letterSpacing: "0.10em",
          }}>
            BYBIT · UID 555753345
          </div>
        </div>
      </aside>

      {/* ══════════════════════════════════════════════════════════
          MAIN COLUMN
      ══════════════════════════════════════════════════════════ */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>

        {/* ── TOP BAR ── */}
        <header style={{
          height: 48,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 16px 0 20px",
          borderBottom: "1px solid var(--m2m-border)",
          background: "var(--m2m-panel)",
          position: "sticky", top: 0, zIndex: 40,
          flexShrink: 0,
        }}>

          {/* Mobile: logo */}
          <div className="md:hidden m2m-logo-entrance" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AllLogoIcon size={18} />
          </div>

          {/* Desktop: page title */}
          <div className="hidden md:flex items-center gap-3">
            <span style={{
              fontFamily: "var(--app-font-sans)", fontSize: 14,
              fontWeight: 600, color: "#fff", letterSpacing: "-0.01em",
            }}>{currentTitle}</span>
            {(bot?.active || bot?.mpActive) && (
              <span style={{
                fontFamily: "var(--app-font-mono)", fontSize: 9, fontWeight: 700,
                padding: "2px 8px", borderRadius: 3,
                background: "rgba(14,203,129,0.10)",
                border: "1px solid rgba(14,203,129,0.22)",
                color: "#0ECB81", letterSpacing: "0.10em",
              }}>ACTIVO</span>
            )}
          </div>

          {/* Right side controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>

            {/* Theme toggle */}
            <button onClick={toggle} style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30, borderRadius: 6,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--m2m-border)",
              cursor: "pointer", fontSize: 14,
              transition: "background 0.15s",
            }}
              title="Cambiar tema"
            >
              {theme === "dark" ? "☀️" : "🌙"}
            </button>

            {/* Mode badge */}
            <button onClick={handleModeBadgeClick} style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 12px", borderRadius: 5,
              border: `1px solid ${isLive ? "rgba(245,166,35,0.30)" : "rgba(0,212,180,0.18)"}`,
              background: isLive ? "rgba(245,166,35,0.08)" : "rgba(0,212,180,0.06)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}>
              <div style={{
                width: 5, height: 5, borderRadius: "50%",
                background: isLive ? AMBER : TEAL,
                boxShadow: `0 0 5px ${isLive ? AMBER : TEAL}`,
              }} />
              <span style={{
                fontFamily: "var(--app-font-mono)", fontWeight: 700,
                fontSize: 9, color: isLive ? AMBER : TEAL, letterSpacing: "0.10em",
              }}>{isLive ? "REAL" : "PAPER"}</span>
            </button>
          </div>
        </header>

        {/* ── TICKER STRIP (desktop only) ── */}
        <div className="hidden md:block" style={{ flexShrink: 0 }}>
          <TickerStrip />
        </div>

        {/* ── SCROLLABLE CONTENT ── */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "20px 20px 80px",
          WebkitOverflowScrolling: "touch" as any,
          overscrollBehavior: "contain",
        }}>
          {children}
        </div>
      </main>

      {/* ══════════════════════════════════════════════════════════
          MOBILE BOTTOM TAB BAR
      ══════════════════════════════════════════════════════════ */}
      <nav className="md:hidden" style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50,
        background: "var(--m2m-panel)",
        borderTop: "1px solid var(--m2m-border)",
        paddingBottom: "env(safe-area-inset-bottom, 8px)",
      }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)" }}>
          {NAV.map(({ href, Icon, label }) => {
            const active = location.startsWith(href);
            const isReal = href === "/live";
            const ac = isReal ? AMBER : TEAL;
            return (
              <Link key={href} href={href} style={{ textDecoration: "none" }}>
                <div style={{
                  display: "flex", flexDirection: "column", alignItems: "center",
                  gap: 3, padding: "10px 0", position: "relative",
                }}>
                  {active && (
                    <div style={{
                      position: "absolute", top: 0, left: "20%", right: "20%", height: 2,
                      background: ac, borderRadius: "0 0 2px 2px",
                    }} />
                  )}
                  <div style={{
                    width: 36, height: 36, borderRadius: 8,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: active ? `rgba(${isReal ? "245,166,35" : "0,212,180"},0.10)` : "transparent",
                    transition: "all 0.15s",
                  }}>
                    <Icon size={17} color={active ? ac : "rgba(255,255,255,0.28)"} />
                  </div>
                  <span style={{
                    fontFamily: "var(--app-font-mono)", fontSize: 9, letterSpacing: "0.04em",
                    color: active ? ac : "rgba(255,255,255,0.25)",
                    fontWeight: active ? 700 : 400,
                    transition: "all 0.15s",
                  }}>{label}</span>
                </div>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Tanit — intacta, sagrada */}
      <TanitChat />

      {/* ══════════════════════════════════════════════════════════
          MODAL: CONFIRMAR CAMBIO A PAPER
      ══════════════════════════════════════════════════════════ */}
      {showModeConfirm && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 200,
          background: "rgba(0,0,0,0.82)", backdropFilter: "blur(12px)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
        }} onClick={() => setShowModeConfirm(false)}>
          <div style={{
            background: "var(--m2m-surface)",
            border: "1px solid rgba(245,166,35,0.22)",
            borderRadius: 12, padding: "28px 24px", maxWidth: 340, width: "100%",
          }} onClick={e => e.stopPropagation()}>
            <div style={{
              fontFamily: "var(--app-font-mono)", fontSize: 9, color: AMBER,
              letterSpacing: "0.20em", marginBottom: 10,
            }}>
              CAMBIAR MODO
            </div>
            <div style={{
              fontFamily: "var(--app-font-sans)", fontWeight: 700, fontSize: 18,
              color: "#fff", marginBottom: 10,
            }}>
              ¿Pasar a Paper?
            </div>
            <div style={{
              fontFamily: "var(--app-font-mono)", fontSize: 10,
              color: "rgba(132,142,156,0.9)", lineHeight: 1.8, marginBottom: 24,
            }}>
              {(bot?.active || bot?.mpActive)
                ? "El bot se detendrá y volverá a simulación. Posiciones abiertas mantienen SL/TP."
                : "El modo volverá a simulación. Activa real cuando quieras."}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button onClick={() => setShowModeConfirm(false)} style={{
                padding: "13px", borderRadius: 8, fontFamily: "var(--app-font-mono)",
                fontWeight: 700, fontSize: 11, letterSpacing: "0.08em",
                background: "rgba(255,255,255,0.04)", color: "rgba(132,142,156,0.9)",
                border: "1px solid var(--m2m-border)", cursor: "pointer",
              }}>CANCELAR</button>
              <button onClick={switchToPaper} disabled={switching} style={{
                padding: "13px", borderRadius: 8, fontFamily: "var(--app-font-mono)",
                fontWeight: 700, fontSize: 11, letterSpacing: "0.08em",
                background: switching ? "rgba(245,166,35,0.3)" : AMBER,
                color: switching ? AMBER : "#0a0500",
                border: "none", cursor: switching ? "not-allowed" : "pointer",
              }}>{switching ? "..." : "SÍ, PAPER"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
