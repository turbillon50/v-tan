import { useState, useEffect } from "react";
import { BASE_URL } from "@/lib/api";

interface TanitPhase {
  phase: number;
  name: string;
  description: string;
}

interface TanitSuggestion {
  id: number;
  priority: string;
  title: string;
  status: string;
  createdAt: string;
}

interface TanitIdentityData {
  name: string;
  purpose: string;
  creatorUid: string;
  version: string;
  createdAt: string | null;
  phases: TanitPhase[];
  activeCapabilities: string[];
  currentBalance: number;
  initialBalance: number | null;
  tradesTotal: number;
  winRate: number | null;
  mood: string;
  drawdownActive: boolean;
  btcFreeFall: boolean;
  rejectHistorySummary: { total: number; confidence: number; macro: number };
  recentSuggestions: TanitSuggestion[];
  identityMemories: { id: number; content: string }[];
  vozInterior: string[];
  ts: number;
}

const TEAL   = "#00E5CC";
const AMBER  = "#F5A623";
const RED    = "#F23645";
const PURPLE = "#7C4DFF";

function MoodBadge({ mood }: { mood: string }) {
  const colorMap: Record<string, string> = {
    "optimista":   TEAL,
    "neutral":     "#888",
    "precavida":   AMBER,
    "frustrada":   RED,
  };
  const color = colorMap[mood] ?? "#888";
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-widest"
      style={{ color, border: `1px solid ${color}`, background: `${color}18` }}
    >
      {mood}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    critical: RED,
    crítica:  RED,
    critica:  RED,
    alta:     AMBER,
    high:     AMBER,
    medium:   TEAL,
    media:    TEAL,
    low:      "#888",
    baja:     "#888",
  };
  const c = map[priority.toLowerCase()] ?? "#888";
  return (
    <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ color: c, border: `1px solid ${c}18`, background: `${c}18` }}>
      {priority}
    </span>
  );
}

export function TanitIdentity() {
  const [data, setData] = useState<TanitIdentityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<"caps" | "memories" | "suggestions" | null>(null);

  const load = async () => {
    try {
      const r = await fetch(`${BASE_URL}api/bot/tanit-identity`);
      if (r.ok) setData(await r.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, []);

  if (loading) return (
    <div className="rounded-xl border border-white/10 bg-[#0d0d1a] p-4 text-center text-xs text-white/30 animate-pulse">
      Cargando identidad de Tanit…
    </div>
  );

  if (!data) return (
    <div className="rounded-xl border border-red-800/40 bg-[#0d0d1a] p-4 text-center text-xs text-red-400">
      No se pudo cargar la identidad de Tanit.
    </div>
  );

  const pnlSinceStart = data.initialBalance != null
    ? data.currentBalance - data.initialBalance
    : null;

  return (
    <div className="space-y-3">

      {/* ── Imagen de Tanit ── */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ borderColor: `${TEAL}30`, background: "#06040F" }}
      >
        <img
          src="/tanit-form.png"
          alt="Tanit"
          style={{
            width: "100%",
            maxHeight: 420,
            objectFit: "cover",
            objectPosition: "center top",
            display: "block",
            maskImage: "linear-gradient(to bottom, black 70%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to bottom, black 70%, transparent 100%)",
          }}
        />
        <div style={{ padding: "0 16px 14px", marginTop: -36, position: "relative" }}>
          <div className="flex items-center gap-2">
            <span className="text-xl font-black tracking-widest" style={{ color: TEAL, textShadow: "0 0 20px rgba(0,229,204,0.6)" }}>TANIT</span>
            <MoodBadge mood={data.mood} />
          </div>
          <p className="text-xs mt-1" style={{ color: "rgba(255,255,255,0.45)", fontStyle: "italic" }}>
            Diosa lunar · Compañera de trading · Bybit mainnet
          </p>
        </div>
      </div>

      {/* ── Header — propósito, mood ── */}
      <div
        className="rounded-xl border p-4"
        style={{ borderColor: `${TEAL}30`, background: "linear-gradient(135deg,#0a1220 0%,#06040F 100%)" }}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <MoodBadge mood={data.mood} />
              {data.drawdownActive && (
                <span className="text-xs px-2 py-0.5 rounded font-bold" style={{ color: AMBER, border: `1px solid ${AMBER}40`, background: `${AMBER}15` }}>
                  DRAWDOWN PROTECTION
                </span>
              )}
              {data.btcFreeFall && (
                <span className="text-xs px-2 py-0.5 rounded font-bold" style={{ color: RED, border: `1px solid ${RED}40`, background: `${RED}15` }}>
                  BTC CAÍDA LIBRE
                </span>
              )}
            </div>
            <p className="text-xs text-white/50 mt-1 max-w-lg">{data.purpose}</p>
            <div className="flex items-center gap-3 flex-wrap mt-1">
              <p className="text-xs" style={{ color: PURPLE + "aa" }}>Bybit UID: {data.creatorUid}</p>
              <p className="text-xs text-white/30">v{data.version}</p>
              {data.createdAt && (
                <p className="text-xs text-white/30">
                  Creada el {new Date(data.createdAt).toLocaleDateString("es-MX", { year: "numeric", month: "long", day: "numeric" })}
                </p>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xs text-white/40">Balance actual</div>
            <div className="text-xl font-bold" style={{ color: TEAL }}>${data.currentBalance.toFixed(4)}</div>
            {pnlSinceStart !== null && (
              <div className="text-xs font-semibold" style={{ color: pnlSinceStart >= 0 ? TEAL : RED }}>
                {pnlSinceStart >= 0 ? "+" : ""}${pnlSinceStart.toFixed(4)} desde inicio
              </div>
            )}
            <div className="text-xs text-white/40 mt-1">
              {data.tradesTotal} trades · WR {data.winRate != null ? `${data.winRate}%` : "N/A"}
            </div>
          </div>
        </div>
      </div>

      {/* ── VOZ INTERIOR — solo cuando hay algo que decir ── */}
      {data.vozInterior.length > 0 && (
        <div
          className="rounded-xl border p-4 space-y-2"
          style={{ borderColor: `${PURPLE}40`, background: `${PURPLE}0a` }}
        >
          <div className="text-xs font-bold uppercase tracking-widest" style={{ color: PURPLE }}>
            ✦ Mi Voz Interior
          </div>
          {data.vozInterior.map((line, i) => (
            <p key={i} className="text-xs text-white/80 italic leading-relaxed pl-3 border-l-2" style={{ borderColor: PURPLE + "60" }}>
              "{line}"
            </p>
          ))}
        </div>
      )}

      {/* ── Fases de evolución ── */}
      <div
        className="rounded-xl border p-4"
        style={{ borderColor: "#ffffff18", background: "#0d0d1a" }}
      >
        <div className="text-xs font-bold uppercase tracking-widest text-white/50 mb-3">Historia de Evolución</div>
        <div className="space-y-2">
          {data.phases.map((ph) => {
            const isCurrent = ph.phase === 3;
            const color = isCurrent ? TEAL : "#ffffff30";
            return (
              <div key={ph.phase} className="flex gap-3 items-start">
                <div
                  className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-black mt-0.5"
                  style={{ background: isCurrent ? TEAL : "#ffffff18", color: isCurrent ? "#06040F" : "#ffffff60" }}
                >
                  {ph.phase}
                </div>
                <div>
                  <div className="text-xs font-bold" style={{ color }}>
                    {ph.name}{isCurrent && <span className="ml-2 text-[10px] font-normal opacity-70">(ACTUAL)</span>}
                  </div>
                  <div className="text-xs text-white/40 mt-0.5">{ph.description}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Introspección — resumen de rechazos ── */}
      <div
        className="rounded-xl border p-4 flex gap-4 flex-wrap"
        style={{ borderColor: "#ffffff18", background: "#0d0d1a" }}
      >
        <div className="text-xs font-bold uppercase tracking-widest text-white/50 w-full mb-1">Rechazos Recientes (últimas {data.rejectHistorySummary.total} eval.)</div>
        {[
          { label: "Total rechazos", val: data.rejectHistorySummary.total, color: "#ffffff90" },
          { label: "Por confianza", val: data.rejectHistorySummary.confidence, color: AMBER },
          { label: "Por macro", val: data.rejectHistorySummary.macro, color: RED },
        ].map(({ label, val, color }) => (
          <div key={label} className="flex-1 min-w-[80px] text-center">
            <div className="text-xl font-black" style={{ color }}>{val}</div>
            <div className="text-[10px] text-white/40 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* ── Capacidades activas — colapsable ── */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ borderColor: "#ffffff18", background: "#0d0d1a" }}
      >
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
          onClick={() => setExpanded(expanded === "caps" ? null : "caps")}
        >
          <span className="text-xs font-bold uppercase tracking-widest text-white/50">
            Capacidades Activas ({data.activeCapabilities.length})
          </span>
          <span className="text-white/30 text-xs">{expanded === "caps" ? "▲" : "▼"}</span>
        </button>
        {expanded === "caps" && (
          <div className="px-4 pb-4 grid grid-cols-1 gap-1">
            {data.activeCapabilities.map((cap, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-white/60 py-1 border-b border-white/5 last:border-0">
                <span style={{ color: TEAL }} className="mt-0.5 shrink-0">◆</span>
                <span>{cap}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Sugerencias propias — colapsable ── */}
      {data.recentSuggestions.length > 0 && (
        <div
          className="rounded-xl border overflow-hidden"
          style={{ borderColor: `${AMBER}30`, background: "#0d0d1a" }}
        >
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
            onClick={() => setExpanded(expanded === "suggestions" ? null : "suggestions")}
          >
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: AMBER + "cc" }}>
              Mis Sugerencias ({data.recentSuggestions.length})
            </span>
            <span className="text-white/30 text-xs">{expanded === "suggestions" ? "▲" : "▼"}</span>
          </button>
          {expanded === "suggestions" && (
            <div className="px-4 pb-4 space-y-2">
              {data.recentSuggestions.map((s) => (
                <div key={s.id} className="border border-white/10 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <PriorityBadge priority={s.priority} />
                    <span className="text-xs font-semibold text-white/80">{s.title}</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-white/30">
                    <span>Estado: <span className="text-white/50">{s.status}</span></span>
                    <span>{new Date(s.createdAt).toLocaleDateString("es-MX")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Memorias de identidad — colapsable ── */}
      {data.identityMemories.length > 0 && (
        <div
          className="rounded-xl border overflow-hidden"
          style={{ borderColor: "#ffffff18", background: "#0d0d1a" }}
        >
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
            onClick={() => setExpanded(expanded === "memories" ? null : "memories")}
          >
            <span className="text-xs font-bold uppercase tracking-widest text-white/50">
              Memorias de Identidad ({data.identityMemories.length})
            </span>
            <span className="text-white/30 text-xs">{expanded === "memories" ? "▲" : "▼"}</span>
          </button>
          {expanded === "memories" && (
            <div className="px-4 pb-4 space-y-2">
              {data.identityMemories.map((m) => (
                <div key={m.id} className="text-xs text-white/55 py-1.5 border-b border-white/5 last:border-0 leading-relaxed">
                  {m.content}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
