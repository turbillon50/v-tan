import { useQuery } from "@tanstack/react-query";
import { BASE_URL } from "@/lib/api";

interface ReasoningEntry {
  symbol: string;
  direction: string;
  rawScore: number;
  finalScore: number;
  confidence: number;
  newsBonus: number;
  patternType: string;
  patternBonus: number;
  patternConf: number;
  patternDesc: string;
  histBonus: number;
  evolBonus: number;
  macroDanger: boolean;
  historicalWR: number;
  historicalN: number;
  historicalAvgPnl: number;
  verdict: string;
  ts: number;
  drawdownActive: boolean;
  btcFreeFall: boolean;
}

interface Guards {
  drawdownActive: boolean;
  drawdownBonus: number;
  btcFreeFall: boolean;
  btcDropPct: number;
  frLongBlock: number;
  atrSlMultiplier: number;
}

interface ReasoningResponse {
  ok: boolean;
  decisions: ReasoningEntry[];
  guards: Guards;
  ts: number;
}

function verdictColor(v: string) {
  if (v === "ACCEPT") return "text-[#00E5CC]";
  if (v === "REJECT_MACRO") return "text-[#F5A623]";
  return "text-[#F23645]";
}

function verdictLabel(v: string) {
  if (v === "ACCEPT") return "✅ ACCEPT";
  if (v === "REJECT_MACRO") return "⚠️ MACRO";
  return "❌ REJECT";
}

function bonus(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function TanitReasoning() {
  const { data, isLoading } = useQuery<ReasoningResponse>({
    queryKey: ["tanit-reasoning"],
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}api/bot/tanit-reasoning`);
      return r.json();
    },
    refetchInterval: 6000,
  });

  const guards   = data?.guards;
  const decisions = data?.decisions ?? [];

  return (
    <div className="space-y-4">
      {/* Guards panel */}
      <div className="bg-[#0D0B1A] border border-[#1E1B2E] rounded-xl p-4">
        <h3 className="text-sm font-semibold text-[#00E5CC] mb-3 uppercase tracking-wider">
          Protección activa
        </h3>
        {guards ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <GuardBadge
              label="Drawdown Guard"
              active={guards.drawdownActive}
              value={guards.drawdownActive ? `+${guards.drawdownBonus}pts umbral` : "off"}
              color="amber"
            />
            <GuardBadge
              label="BTC Free Fall"
              active={guards.btcFreeFall}
              value={guards.btcFreeFall ? `-${guards.btcDropPct.toFixed(2)}% en 5min` : `${guards.btcDropPct.toFixed(2)}%`}
              color="red"
            />
            <GuardBadge
              label="Funding Guard"
              active={false}
              value={`≤${guards.frLongBlock}% threshold`}
              color="purple"
            />
            <GuardBadge
              label="ATR SL Mult"
              active={guards.atrSlMultiplier !== 1.5}
              value={`${guards.atrSlMultiplier}×`}
              color="teal"
            />
          </div>
        ) : (
          <div className="text-xs text-gray-500">Cargando...</div>
        )}
      </div>

      {/* Decisions table */}
      <div className="bg-[#0D0B1A] border border-[#1E1B2E] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#1E1B2E] flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[#00E5CC] uppercase tracking-wider">
            Razonamiento causal — últimas decisiones
          </h3>
          <span className="text-xs text-gray-500">{decisions.length} entradas</span>
        </div>

        {isLoading ? (
          <div className="p-6 text-center text-gray-500 text-sm">Cargando razonamientos...</div>
        ) : decisions.length === 0 ? (
          <div className="p-6 text-center text-gray-500 text-sm">
            Sin decisiones aún — Tanit analiza cada símbolo cada 15s
          </div>
        ) : (
          <div className="divide-y divide-[#1E1B2E] max-h-[460px] overflow-y-auto">
            {decisions.map((d, i) => (
              <div key={i} className="px-4 py-3 hover:bg-[#110D24] transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-white font-bold text-sm">
                        {d.symbol.replace("USDT", "")}
                      </span>
                      <span className={`text-xs font-semibold ${d.direction === "LONG" ? "text-[#00E5CC]" : "text-[#F23645]"}`}>
                        {d.direction}
                      </span>
                      <span className={`text-xs font-bold ${verdictColor(d.verdict)}`}>
                        {verdictLabel(d.verdict)}
                      </span>
                      <span className="text-xs text-gray-500 ml-auto">{formatTime(d.ts)}</span>
                    </div>

                    {/* Score row */}
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs mt-1">
                      <span className="text-gray-400">Score base: <span className="text-white">{d.rawScore.toFixed(1)}</span></span>
                      <span className="text-gray-400">Final: <span className="text-white font-semibold">{d.finalScore.toFixed(1)}</span></span>
                      <span className="text-gray-400">Conf: <span className={`font-semibold ${d.confidence >= 65 ? "text-[#00E5CC]" : d.confidence >= 55 ? "text-[#F5A623]" : "text-[#F23645]"}`}>{d.confidence.toFixed(0)}%</span></span>
                    </div>

                    {/* Bonus breakdown */}
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs mt-1">
                      {d.newsBonus !== 0 && (
                        <span className={d.newsBonus > 0 ? "text-green-400" : "text-red-400"}>
                          📰 news {bonus(d.newsBonus)}
                        </span>
                      )}
                      {d.patternType !== "NONE" && (
                        <span className={d.patternBonus > 0 ? "text-[#00E5CC]" : "text-[#F23645]"}>
                          📐 {d.patternType} {bonus(d.patternBonus)} ({Math.round(d.patternConf * 100)}%)
                        </span>
                      )}
                      {d.histBonus !== 0 && (
                        <span className={d.histBonus > 0 ? "text-purple-400" : "text-orange-400"}>
                          🧠 hist {bonus(d.histBonus)}
                        </span>
                      )}
                      {d.evolBonus !== 0 && (
                        <span className={d.evolBonus > 0 ? "text-blue-400" : "text-orange-400"}>
                          ⚡ evol {bonus(d.evolBonus)}
                        </span>
                      )}
                    </div>

                    {/* Pattern description */}
                    {d.patternDesc && d.patternType !== "NONE" && (
                      <div className="text-xs text-gray-500 mt-1 italic truncate" title={d.patternDesc}>
                        {d.patternDesc}
                      </div>
                    )}

                    {/* Historical context */}
                    {d.historicalN > 0 && (
                      <div className="text-xs text-gray-500 mt-1">
                        Histórico: {d.historicalN} casos similares — WR {d.historicalWR}%
                        {d.historicalAvgPnl !== 0 && ` avg ${d.historicalAvgPnl >= 0 ? "+" : ""}$${d.historicalAvgPnl.toFixed(2)}`}
                      </div>
                    )}

                    {/* Macro / guards flags */}
                    {d.macroDanger && (
                      <div className="text-xs text-[#F5A623] mt-1">⚠️ Zona macro peligro — evento USD alto impacto</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GuardBadge({
  label,
  active,
  value,
  color,
}: {
  label: string;
  active: boolean;
  value: string;
  color: "amber" | "red" | "purple" | "teal";
}) {
  const colorMap = {
    amber:  { bg: "bg-amber-900/30",  border: "border-amber-700/40",  text: "text-amber-400"  },
    red:    { bg: "bg-red-900/30",    border: "border-red-700/40",    text: "text-red-400"    },
    purple: { bg: "bg-purple-900/30", border: "border-purple-700/40", text: "text-purple-400" },
    teal:   { bg: "bg-teal-900/30",   border: "border-teal-700/40",   text: "text-teal-400"   },
  }[color];

  return (
    <div className={`rounded-lg border p-2 ${active ? colorMap.bg : "bg-[#110D24]"} ${active ? colorMap.border : "border-[#2A2640]"}`}>
      <div className="text-gray-400 text-[10px] uppercase tracking-wider mb-1">{label}</div>
      <div className={`font-semibold text-xs ${active ? colorMap.text : "text-gray-500"}`}>
        {active ? "🔴 ACTIVO" : "🟢 OK"} — {value}
      </div>
    </div>
  );
}
