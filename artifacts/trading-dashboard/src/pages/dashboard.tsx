import { useState, useEffect } from "react";
import { Layout } from "@/components/layout";
import {
  useGetTicker, useGetCandles, useGetIndicators, useGetSignal,
  useGetAiAnalysis, useGetBalance, useGetPositions, useGetTrades,
  useGetPortfolioStats, useGetMarketSentiment, useGetFundingRate,
  useGetOpenInterest, useCalculatePosition, useOpenOrder, useCloseOrder,
} from "@workspace/api-client-react";
import {
  BarChart, Bar, ReferenceLine, ResponsiveContainer,
  AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { UpArrow, DownArrow, MinusIcon, InfoIcon, RefreshIcon, AlertIcon, SparklesIcon, DollarIcon, ActivityIcon, LayersIcon } from "@/components/TradeIcons";

// ─── Constants ────────────────────────────────────────────────────────────────
const SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","ARBUSDT","OPUSDT"];
const SYM: Record<string,string> = { BTCUSDT:"BTC",ETHUSDT:"ETH",SOLUSDT:"SOL",BNBUSDT:"BNB",XRPUSDT:"XRP",DOGEUSDT:"DOGE",AVAXUSDT:"AVAX",LINKUSDT:"LINK",ARBUSDT:"ARB",OPUSDT:"OP" };
const IVLS = [{ v:"1",l:"1m" },{ v:"5",l:"5m" },{ v:"15",l:"15m" },{ v:"60",l:"1h" },{ v:"240",l:"4h" }];
const GREEN = "#00C9A7";
const RED   = "#E879A0";
const AMBER = "#FF9500";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (n: number, d = 2) => {
  if (n == null) return "--";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return n.toFixed(d);
};
const fmtUSD = (n: number, d = 2) => "$" + fmt(n, d);
const pctColor = (v: number) => v >= 0 ? GREEN : RED;
const scoreToColor = (s: number) => s >= 70 ? GREEN : s >= 45 ? AMBER : RED;
const fearLabel = (v: number) => v >= 75 ? "Codicia Extrema" : v >= 55 ? "Codicia" : v >= 45 ? "Neutral" : v >= 25 ? "Miedo" : "Miedo Extremo";
const fearColor = (v: number) => v >= 55 ? GREEN : v >= 45 ? AMBER : RED;

// ─── Sub-components ───────────────────────────────────────────────────────────

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{ color, background: color + "18", border: `1px solid ${color}30` }}>
      {children}
    </span>
  );
}

function StatCard({ label, value, sub, valueColor, guide }: {
  label: string; value: string; sub?: string; valueColor?: string; guide?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-1 group relative">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
        {guide && (
          <div className="relative">
            <InfoIcon className="w-3 h-3 text-muted-foreground/40 cursor-help" />
            <div className="absolute left-0 bottom-5 hidden group-hover:block z-50 bg-popover border border-border rounded-lg p-2 w-44 text-[11px] text-muted-foreground leading-relaxed shadow-lg">
              {guide}
            </div>
          </div>
        )}
      </div>
      <div className="text-xl font-bold font-mono tabular-nums" style={{ color: valueColor }}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function SectionHeader({ title, guide }: { title: string; guide?: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <h2 className="font-display text-sm font-bold uppercase tracking-wide text-foreground">{title}</h2>
      {guide && (
        <span className="text-[11px] text-muted-foreground font-normal normal-case tracking-normal">{guide}</span>
      )}
    </div>
  );
}

function RSIArc({ value }: { value: number }) {
  const c = value < 30 ? GREEN : value > 70 ? RED : AMBER;
  const lbl = value < 30 ? "Sobrevendido — posible rebote" : value > 70 ? "Sobrecomprado — cuidado" : value > 50 ? "Fuerza alcista" : "Presión bajista";
  return (
    <div className="flex items-center gap-3">
      <div className="relative w-14 h-14">
        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
          <circle cx="18" cy="18" r="14" fill="none" stroke="hsl(var(--muted))" strokeWidth="3.5"/>
          <circle cx="18" cy="18" r="14" fill="none" stroke={c} strokeWidth="3.5"
            strokeDasharray={`${(value/100)*87.96} 87.96`} strokeLinecap="round" style={{ transition: "stroke-dasharray 0.8s ease" }}/>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-[11px] font-bold font-mono" style={{ color: c }}>
          {value.toFixed(0)}
        </div>
      </div>
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">RSI 14</div>
        <div className="text-xs font-semibold" style={{ color: c }}>{lbl}</div>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState("5");
  const [calcLev, setCalcLev] = useState(20);
  const [calcPct, setCalcPct] = useState(5);
  const [chartMode, setChartMode] = useState<"area" | "candle">("candle");

  const opts = (extra?: object) => ({ query: { refetchInterval: 5000, ...extra } as any });

  const { data: ticker }     = useGetTicker({ symbol }, { query: { refetchInterval: 3000 } as any });
  const { data: candles }    = useGetCandles({ symbol, interval: interval as any }, { query: { refetchInterval: 30000 } as any });
  const { data: indicators } = useGetIndicators(symbol, undefined, { query: { refetchInterval: 30000 } as any });
  const { data: signal }     = useGetSignal(symbol, { query: { refetchInterval: 30000 } as any });
  const { data: ai }         = useGetAiAnalysis(symbol, { query: { refetchInterval: 300000 } as any });
  const { data: balance }    = useGetBalance({ query: { refetchInterval: 10000 } as any });
  const { data: positions }  = useGetPositions({ query: { refetchInterval: 5000 } as any });
  const { data: trades }     = useGetTrades({ query: { refetchInterval: 30000 } as any });
  const { data: stats }      = useGetPortfolioStats({ query: { refetchInterval: 30000 } as any });
  const { data: sentiment }  = useGetMarketSentiment({ query: { refetchInterval: 60000 } as any });
  const { data: funding }    = useGetFundingRate({ symbol }, { query: { refetchInterval: 60000 } as any });
  const { data: oi }         = useGetOpenInterest({ symbol }, { query: { refetchInterval: 60000 } as any });

  const calcMut  = useCalculatePosition();
  const openOrd  = useOpenOrder();
  const closeOrd = useCloseOrder();

  useEffect(() => {
    if (ticker?.price) {
      calcMut.mutate({ data: { symbol, side: "Buy", leverage: calcLev, capitalPercent: calcPct, entryPrice: ticker.price } });
    }
  }, [symbol, calcLev, calcPct, Math.round((ticker?.price ?? 0) / 10)]);

  const chartData = (candles ?? []).slice(-200).map(c => ({
    time:   c.time,
    open:   c.open,
    high:   c.high,
    low:    c.low,
    close:  c.close,
    volume: c.volume,
  }));

  const macdHist = (candles ?? []).slice(-25).map((c, i, arr) => ({
    t: new Date(c.time * 1000).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }),
    hist: c.close - arr[Math.max(0, i - 3)].close,
  }));

  const pos = positions?.[0];
  const sColor = signal ? scoreToColor(signal.score) : "hsl(var(--muted-foreground))";


  return (
    <Layout>
      <div className="space-y-6 max-w-[1600px]">
        {/* ── Header ── */}
        <div className="space-y-3">
          <div>
            <h1 className="font-display text-xl md:text-2xl font-bold text-foreground">Terminal de Trading</h1>
            <p className="text-xs md:text-sm text-muted-foreground mt-0.5">Precios en vivo, indicadores técnicos y señales algorítmicas</p>
          </div>
          {/* Symbol selector — single scroll row on mobile */}
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1">
            {SYMBOLS.map(s => (
              <button key={s} onClick={() => setSymbol(s)} data-testid={`btn-symbol-${s}`}
                className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-all ${symbol === s
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "bg-muted/30 text-muted-foreground border border-border hover:border-primary/20 hover:text-foreground"}`}>
                {SYM[s]}
              </button>
            ))}
          </div>
        </div>

        {/* ── KPI Row ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
          <div className="bg-card border border-border rounded-xl p-4 col-span-2">
            <div className="text-xs text-muted-foreground mb-1">{SYM[symbol]}/USDT — Precio actual</div>
            <div className="flex items-end gap-3">
              <div className="text-2xl md:text-3xl font-bold font-mono tabular-nums text-foreground" data-testid="ticker-price">
                {ticker ? fmtUSD(ticker.price) : <span className="shimmer w-28 h-8 rounded inline-block" />}
              </div>
              <div className="text-sm font-semibold font-mono mb-0.5" style={{ color: pctColor(ticker?.changePercent24h ?? 0) }} data-testid="ticker-change">
                {ticker ? `${ticker.changePercent24h >= 0 ? "+" : ""}${ticker.changePercent24h.toFixed(2)}%` : ""}
              </div>
            </div>
          </div>
          <StatCard label="Balance" value={balance ? fmtUSD(balance.totalEquity) : "--"} data-testid="balance-equity"
            sub="Capital disponible" guide="Tu equity total incluyendo posiciones abiertas." />
          <StatCard label="PnL No Realizado" value={balance ? `${balance.unrealizedPnl >= 0 ? "+" : ""}${fmtUSD(balance.unrealizedPnl)}` : "--"}
            valueColor={pctColor(balance?.unrealizedPnl ?? 0)} guide="Ganancia/pérdida de posiciones abiertas que no se ha cerrado." />
          <StatCard label="Funding Rate" value={funding ? `${funding.rate.toFixed(4)}%` : "--"}
            valueColor={funding && funding.rate > 0 ? RED : GREEN}
            sub="Costo de mantener posición" guide="Si es positivo, los longs pagan. Si negativo, los shorts pagan." />
          <StatCard label="Interés Abierto" value={oi ? fmt(oi.openInterestValue) : "--"} guide="Total de contratos abiertos en el mercado. Más OI = más participación." />
        </div>

        {/* ── Main Grid ── */}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-6">
          {/* Left column */}
          <div className="space-y-6">
            {/* Chart */}
            <div className="bg-card border border-border rounded-xl p-4 md:p-5">
              <div className="flex items-center justify-between mb-3 md:mb-4 gap-2 flex-wrap">
                <div className="min-w-0">
                  <SectionHeader title={`${SYM[symbol]} — Precio`} />
                  <p className="text-[11px] text-muted-foreground -mt-3 hidden md:block">Scroll = zoom · Drag = pan · Tiempo real</p>
                </div>
                <div className="flex gap-1 flex-wrap shrink-0">
                  {/* Chart mode toggle */}
                  {(["candle","area"] as const).map(m => (
                    <button key={m} onClick={() => setChartMode(m)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${chartMode === m
                        ? "bg-primary/15 text-primary border border-primary/25"
                        : "text-muted-foreground border border-border hover:border-primary/20"}`}>
                      {m === "candle" ? "Velas" : "Línea"}
                    </button>
                  ))}
                  <div className="w-px bg-border mx-0.5" />
                  {IVLS.map(iv => (
                    <button key={iv.v} onClick={() => setInterval(iv.v)} data-testid={`btn-interval-${iv.v}`}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${interval === iv.v
                        ? "bg-primary/15 text-primary border border-primary/25"
                        : "text-muted-foreground border border-border hover:border-primary/20"}`}>
                      {iv.l}
                    </button>
                  ))}
                </div>
              </div>
              {chartData.length > 0 ? (
                <AreaChart
                  key={`${symbol}-${interval}-${chartMode}`}
                  width={0}
                  height={400}
                  data={chartData}
                  style={{ width: "100%" }}
                >
                  <defs>
                    <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#00E5CC" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#00E5CC" stopOpacity={0}    />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                  <XAxis dataKey="time" hide />
                  <YAxis domain={["auto","auto"]} hide />
                  <Tooltip
                    contentStyle={{ background:"#0f1117", border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, fontSize:12 }}
                    labelStyle={{ color:"#94a3b8" }}
                    itemStyle={{ color:"#00E5CC" }}
                    formatter={(v: number) => [v.toFixed(4), "Close"]}
                  />
                  <Area type="monotone" dataKey="close" stroke="#00E5CC" strokeWidth={1.5} fill="url(#chartGrad)" dot={false} activeDot={{ r:3 }} />
                </AreaChart>
              ) : (
                <div className="h-[400px] flex items-center justify-center rounded-xl border border-dashed border-border">
                  <div className="shimmer w-full h-full rounded-xl" />
                </div>
              )}
            </div>

            {/* Indicators + AI */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Indicators */}
              <div className="bg-card border border-border rounded-xl p-5 space-y-4">
                <div>
                  <SectionHeader title="Indicadores Técnicos" />
                  <p className="text-[11px] text-muted-foreground -mt-3 mb-3">
                    Calculados sobre las últimas velas de {SYM[symbol]}. Te dicen el estado del mercado sin suposiciones.
                  </p>
                </div>
                {indicators ? (
                  <>
                    <RSIArc value={indicators.rsi} />
                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { lbl: "MACD", val: indicators.macd.macd.toFixed(2), color: indicators.macd.macd >= 0 ? GREEN : RED, tip: "Diferencia entre EMAs 12 y 26. Positivo = momentum alcista." },
                        { lbl: "Señal MACD", val: indicators.macd.signal.toFixed(2), tip: "EMA del MACD. Cruce hacia arriba = entrada potencial." },
                        { lbl: "EMA 9", val: fmtUSD(indicators.ema9), color: indicators.ema9 > indicators.ema21 ? GREEN : RED, tip: "Media móvil rápida. Si está sobre EMA 21, tendencia alcista corto plazo." },
                        { lbl: "EMA 21", val: fmtUSD(indicators.ema21), tip: "Referencia de mediano plazo." },
                        { lbl: "EMA 50", val: fmtUSD(indicators.ema50), tip: "Tendencia de fondo. Si el precio está arriba, bullish." },
                        { lbl: "ATR", val: indicators.atr.toFixed(2), tip: "Rango promedio de vela. Mide volatilidad del activo." },
                        { lbl: "BB Superior", val: fmtUSD(indicators.bollingerBands.upper), color: AMBER, tip: "Precio cerca de aquí = resistencia dinámica." },
                        { lbl: "BB Inferior", val: fmtUSD(indicators.bollingerBands.lower), color: "#60A5FA", tip: "Precio cerca de aquí = soporte dinámico." },
                        { lbl: "Vol. Ratio", val: indicators.volume.ratio.toFixed(2) + "x", color: indicators.volume.ratio > 1.2 ? GREEN : indicators.volume.ratio < 0.8 ? RED : undefined, tip: "Volumen actual vs promedio. >1.2 = movimiento con fuerza real." },
                        { lbl: "CVD Delta", val: (indicators.cvd >= 0 ? "+" : "") + fmt(indicators.cvd, 0), color: indicators.cvd >= 0 ? GREEN : RED, tip: "Volumen delta acumulado. Positivo = presión compradora neta." },
                      ].map(({ lbl, val, color, tip }) => (
                        <div key={lbl} className="bg-muted/20 rounded-lg p-2.5 group relative cursor-help">
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{lbl}</div>
                          <div className="text-sm font-bold font-mono tabular-nums mt-0.5" style={{ color }}>{val}</div>
                          <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50 bg-popover border border-border rounded-lg p-2 w-48 text-[11px] text-muted-foreground leading-relaxed shadow-lg">
                            {tip}
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* MACD histogram */}
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Histograma MACD</div>
                      <ResponsiveContainer width="100%" height={50}>
                        <BarChart data={macdHist.slice(-20)} barSize={5}>
                          <ReferenceLine y={0} stroke="hsl(var(--border))" />
                          <Bar dataKey="hist" radius={2}
                            fill={GREEN}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                ) : (
                  <div className="space-y-2">
                    {[...Array(6)].map((_, i) => (
                      <div key={i} className="shimmer h-10 rounded-lg" />
                    ))}
                  </div>
                )}
              </div>

              {/* AI */}
              <div className="bg-card border border-border rounded-xl p-5 space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="font-display text-sm font-bold uppercase tracking-wide">Análisis IA — Gemini</h2>
                    <SparklesIcon className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Gemini analiza todos los indicadores juntos y genera una narrativa de mercado + recomendación. Se actualiza cada 5 min.
                  </p>
                </div>
                {ai ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Pill color={ai.sentiment === "BULLISH" ? GREEN : ai.sentiment === "BEARISH" ? RED : AMBER}>
                        {ai.sentiment === "BULLISH" ? <UpArrow className="w-3 h-3" /> : ai.sentiment === "BEARISH" ? <DownArrow className="w-3 h-3" /> : <MinusIcon className="w-3 h-3" />}
                        {ai.sentiment}
                      </Pill>
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">{ai.narrative}</p>
                    <div className="bg-primary/5 border border-primary/15 rounded-lg p-3">
                      <div className="text-[10px] text-primary uppercase tracking-wider mb-1 font-semibold">Recomendación</div>
                      <p className="text-sm font-medium text-foreground">{ai.recommendation}</p>
                    </div>
                    <div className="text-[11px] text-muted-foreground/50 font-mono">
                      Último análisis: {new Date(ai.updatedAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className="shimmer h-4 rounded" style={{ width: `${75 + i * 5}%` }} />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Trade History */}
            <div className="bg-card border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-1">
                <SectionHeader title="Historial de Operaciones" />
                {stats && (
                  <div className="flex gap-4 text-xs -mt-4">
                    <span className="text-muted-foreground">Win Rate: <span className="font-bold font-mono" style={{ color: GREEN }}>{stats.winRate}%</span></span>
                    <span className="text-muted-foreground">PnL: <span className="font-bold font-mono" style={{ color: pctColor(stats.totalPnl) }}>{stats.totalPnl >= 0 ? "+" : ""}{fmtUSD(stats.totalPnl)}</span></span>
                  </div>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground mb-4 -mt-2">
                Cada fila es una operación cerrada. PnL calculado sobre el margen utilizado con apalancamiento aplicado.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      {["Par","Dirección","Entrada","Salida","PnL","Retorno","Lev","Modo"].map(h => (
                        <th key={h} className={`pb-2 font-medium ${h === "Par" || h === "Dirección" ? "text-left" : "text-right"}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(trades ?? []).map(t => (
                      <tr key={t.id} data-testid={`row-trade-${t.id}`} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                        <td className="py-2 font-bold font-mono">{SYM[t.symbol] ?? t.symbol}</td>
                        <td className="py-2">
                          <Pill color={t.side === "Buy" ? GREEN : RED}>
                            {t.side === "Buy" ? <UpArrow className="w-3 h-3" /> : <DownArrow className="w-3 h-3" />}
                            {t.side === "Buy" ? "LONG" : "SHORT"}
                          </Pill>
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums">{fmtUSD(t.entryPrice)}</td>
                        <td className="py-2 text-right font-mono tabular-nums">{fmtUSD(t.exitPrice)}</td>
                        <td className="py-2 text-right font-mono tabular-nums font-bold" style={{ color: pctColor(t.pnl) }}>
                          {t.pnl >= 0 ? "+" : ""}{fmtUSD(t.pnl)}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums" style={{ color: pctColor(t.pnlPercent) }}>
                          {t.pnlPercent >= 0 ? "+" : ""}{t.pnlPercent.toFixed(2)}%
                        </td>
                        <td className="py-2 text-right font-mono">{t.leverage}x</td>
                        <td className="py-2 text-right">
                          <Pill color={t.riskMode === "ultra" ? RED : t.riskMode === "risky" ? AMBER : GREEN}>
                            {t.riskMode.toUpperCase()}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(!trades || trades.length === 0) && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Sin operaciones cerradas todavía. Abre tu primer trade desde la calculadora.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Right Sidebar ── */}
          <div className="space-y-4">
            {/* Signal */}
            <div className="bg-card border border-border rounded-xl p-5" style={{ borderColor: signal ? sColor + "40" : undefined }}>
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-display text-sm font-bold uppercase tracking-wide">Motor de Señales</h2>
                <ActivityIcon className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-[11px] text-muted-foreground mb-4">Score 0-100 basado en RSI, MACD, EMA, volumen y CVD combinados.</p>
              {signal ? (
                <div className="space-y-3">
                  <div className="flex items-end gap-3">
                    <div className="text-5xl font-bold font-mono tabular-nums" style={{ color: sColor }} data-testid="signal-score">
                      {signal.score}
                    </div>
                    <div className="mb-1">
                      <Pill color={signal.direction === "LONG" ? GREEN : signal.direction === "SHORT" ? RED : AMBER}>
                        {signal.direction === "LONG" ? <UpArrow className="w-3 h-3" /> : signal.direction === "SHORT" ? <DownArrow className="w-3 h-3" /> : <MinusIcon className="w-3 h-3" />}
                        {signal.strength === "STRONG" ? "FUERTE " : ""}{signal.direction}
                      </Pill>
                    </div>
                  </div>
                  <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${signal.score}%`, background: sColor }} />
                  </div>
                  <ul className="space-y-1.5">
                    {signal.reasons.slice(0, 4).map((r, i) => (
                      <li key={i} className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                        <span style={{ color: sColor }} className="mt-0.5">›</span>{r}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {[...Array(3)].map((_, i) => <div key={i} className="shimmer h-4 rounded" />)}
                </div>
              )}
            </div>

            {/* Position */}
            <div className="bg-card border border-border rounded-xl p-5"
              style={{ borderColor: pos ? (pos.unrealizedPnl >= 0 ? GREEN + "40" : RED + "40") : undefined }}>
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-display text-sm font-bold uppercase tracking-wide">Posición Activa</h2>
                <LayersIcon className="w-4 h-4 text-muted-foreground" />
              </div>
              <p className="text-[11px] text-muted-foreground mb-4">Tu trade abierto. SL/TP se calculan automáticamente según el modo de riesgo.</p>
              {pos ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-xs">Par</span>
                    <span className="font-bold font-mono">{SYM[pos.symbol]}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-xs">Dirección</span>
                    <Pill color={pos.side === "Buy" ? GREEN : RED} data-testid="pos-side">
                      {pos.side === "Buy" ? <UpArrow className="w-3 h-3" /> : <DownArrow className="w-3 h-3" />}
                      {pos.side === "Buy" ? "LONG" : "SHORT"}
                    </Pill>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-xs">PnL</span>
                    <div className="text-right">
                      <div className="font-bold font-mono" style={{ color: pctColor(pos.unrealizedPnl) }} data-testid="pos-pnl">
                        {pos.unrealizedPnl >= 0 ? "+" : ""}{fmtUSD(pos.unrealizedPnl)}
                      </div>
                      <div className="text-[10px] font-mono" style={{ color: pctColor(pos.unrealizedPnlPercent) }}>
                        {pos.unrealizedPnlPercent >= 0 ? "+" : ""}{pos.unrealizedPnlPercent.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Entrada</span>
                    <span className="font-mono">{fmtUSD(pos.entryPrice)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Apalancamiento</span>
                    <span className="font-mono font-bold">{pos.leverage}x</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-[#E879A0]">Liquidación</span>
                    <span className="font-mono text-[#E879A0] font-bold">{fmtUSD(pos.liquidationPrice)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-[11px] pt-1 border-t border-border">
                    <div className="bg-[#E879A0]/8 border border-[#E879A0]/20 rounded-lg p-2">
                      <div className="text-[#E879A0] text-[10px]">Stop Loss</div>
                      <div className="font-mono font-bold text-[#E879A0]">{fmtUSD(pos.stopLoss)}</div>
                    </div>
                    {[["TP1", pos.takeProfit1], ["TP2", pos.takeProfit2], ["TP3", pos.takeProfit3]].map(([lbl, val]) => (
                      <div key={lbl as string} className="bg-primary/5 border border-primary/15 rounded-lg p-2">
                        <div className="text-primary text-[10px]">{lbl as string}</div>
                        <div className="font-mono font-bold text-primary">{fmtUSD(val as number)}</div>
                      </div>
                    ))}
                  </div>
                  <button data-testid="btn-close-position"
                    onClick={() => closeOrd.mutate({ data: { symbol: pos.symbol } })}
                    className="w-full mt-2 py-2 rounded-lg border border-destructive text-destructive text-xs font-bold hover:bg-destructive hover:text-white transition-all">
                    {closeOrd.isPending ? "Cerrando..." : "Cerrar Posición"}
                  </button>
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  Sin posiciones abiertas.
                  <br /><span className="text-xs text-muted-foreground/50">Usa la calculadora para abrir.</span>
                </div>
              )}
            </div>

            {/* Sentiment */}
            <div className="bg-card border border-border rounded-xl p-5">
              <h2 className="font-display text-sm font-bold uppercase tracking-wide mb-1">Sentimiento de Mercado</h2>
              <p className="text-[11px] text-muted-foreground mb-4">El Fear & Greed Index mide el estado psicológico del mercado cripto. Extremo miedo = oportunidad de compra.</p>
              {sentiment ? (
                <div className="space-y-3">
                  <div className="text-center">
                    <div className="text-4xl font-bold font-mono tabular-nums" style={{ color: fearColor(sentiment.fearGreedIndex) }} data-testid="fear-greed-index">
                      {sentiment.fearGreedIndex}
                    </div>
                    <div className="text-xs font-semibold mt-1" style={{ color: fearColor(sentiment.fearGreedIndex) }}>
                      {fearLabel(sentiment.fearGreedIndex)}
                    </div>
                  </div>
                  <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${sentiment.fearGreedIndex}%`, background: fearColor(sentiment.fearGreedIndex) }} />
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>Miedo</span>
                    <span>BTC Dom: <b className="text-foreground">{sentiment.btcDominance.toFixed(1)}%</b></span>
                    <span>Codicia</span>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-2">Ballenas recientes</div>
                    {sentiment.whaleActivity.slice(0, 3).map((w, i) => (
                      <div key={i} className="flex justify-between items-center py-1 text-xs border-b border-border/30 last:border-0">
                        <span style={{ color: w.type === "buy" ? GREEN : RED }}>
                          {w.type === "buy" ? "▲" : "▼"} {SYM[w.symbol] ?? w.symbol}
                        </span>
                        <span className="font-mono text-muted-foreground">${(w.amount / 1e6).toFixed(1)}M</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="shimmer h-24 rounded-lg" />
              )}
            </div>

            {/* Calculator */}
            <div className="bg-card border border-border rounded-xl p-5">
              <h2 className="font-display text-sm font-bold uppercase tracking-wide mb-1">Calculadora de Posición</h2>
              <p className="text-[11px] text-muted-foreground mb-4">
                Ajusta el apalancamiento y el % de capital para ver cuánto ganarías/perderías antes de entrar.
              </p>
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Apalancamiento</span>
                    <span className="font-bold font-mono" style={{ color: calcLev > 50 ? RED : calcLev > 20 ? AMBER : GREEN }}>{calcLev}x</span>
                  </div>
                  <input type="range" min={5} max={100} step={5} value={calcLev}
                    onChange={e => setCalcLev(+e.target.value)}
                    data-testid="calc-leverage"
                    className="w-full accent-primary cursor-pointer" />
                  <div className="flex justify-between text-[10px] text-muted-foreground/50 mt-0.5">
                    <span>5x — Conservador</span><span>100x — Ultra</span>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">% de Capital</span>
                    <span className="font-bold font-mono">{calcPct}%</span>
                  </div>
                  <input type="range" min={1} max={20} step={1} value={calcPct}
                    onChange={e => setCalcPct(+e.target.value)}
                    data-testid="calc-capital"
                    className="w-full accent-primary cursor-pointer" />
                </div>
                {calcMut.data && (
                  <div className="space-y-2 border-t border-border pt-3">
                    {[
                      { lbl: "Margen usado",     val: fmtUSD(calcMut.data.margin),         c: undefined },
                      { lbl: "Tamaño posición",  val: fmtUSD(calcMut.data.positionSize),    c: undefined },
                      { lbl: "TP1 +3%",          val: "+" + fmtUSD(calcMut.data.pnlTp1),    c: GREEN },
                      { lbl: "TP2 +7%",          val: "+" + fmtUSD(calcMut.data.pnlTp2),    c: GREEN },
                      { lbl: "TP3 +15%",         val: "+" + fmtUSD(calcMut.data.pnlTp3),    c: GREEN },
                      { lbl: "Stop Loss -2%",    val: fmtUSD(calcMut.data.pnlSl),           c: RED },
                      { lbl: "Liquidación",      val: fmtUSD(calcMut.data.liquidationPrice), c: RED },
                    ].map(({ lbl, val, c }) => (
                      <div key={lbl} className="flex justify-between text-xs">
                        <span className="text-muted-foreground">{lbl}</span>
                        <span className="font-mono font-bold" style={{ color: c }}>{val}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button data-testid="btn-open-long"
                    onClick={() => openOrd.mutate({ data: { symbol, side: "Buy", riskMode: "risky" } })}
                    className="py-2.5 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs font-bold hover:bg-primary/20 transition-all flex items-center justify-center gap-1">
                    <UpArrow className="w-3.5 h-3.5" />
                    {openOrd.isPending ? "..." : "Long"}
                  </button>
                  <button data-testid="btn-open-short"
                    onClick={() => openOrd.mutate({ data: { symbol, side: "Sell", riskMode: "risky" } })}
                    className="py-2.5 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs font-bold hover:bg-destructive/20 transition-all flex items-center justify-center gap-1">
                    <DownArrow className="w-3.5 h-3.5" />
                    {openOrd.isPending ? "..." : "Short"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
