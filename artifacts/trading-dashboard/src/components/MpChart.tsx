import { useState, useEffect, useRef, useCallback } from "react";
import { BASE_URL } from "@/lib/api";

const TEAL  = "#00D4AA";
const RED   = "#F23645";
const BLUE  = "#7090ff";
const WHITE = "#ffffff";
const DIM   = "#5a5a8a";
const AMBER = "#FF9500";
const DEEP  = "#030310";

type Candle = { time: number; open: number; high: number; low: number; close: number };

function pct(a: number, b: number) { return ((b - a) / a) * 100; }

function fmtPrice(p: number): string {
  if (!p) return "—";
  if (p >= 10000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 100)   return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  return p.toFixed(5);
}

export interface MpChartProps {
  symbol:        string;
  entryPrice:    number;
  rangeLow:      number;
  rangeHigh:     number;
  longCloseAt?:    number;
  shortCloseAt?:   number;
  longTrailStop?:  number | null;
  shortTrailStop?: number | null;
  currentPrice:    number;
  longClosed:      boolean;
  shortClosed:     boolean;
  longPnl:       number;
  shortPnl:      number;
  leverage:      number;
  unrealizedPnl: number;
  longAvgEntry?: number;   // entrada promedio LONG (cambia con escalas)
  shortAvgEntry?: number;  // entrada promedio SHORT (cambia con escalas)
  longScaleCount?: number;
  shortScaleCount?: number;
  onLevelsChange?: (symbol: string, high: number, low: number) => void;
}

const CHART_H = 200;
const PAD = { top: 28, bottom: 22, left: 0, right: 80 };

export function MpChart({
  symbol, entryPrice, currentPrice,
  longClosed, shortClosed, longPnl, shortPnl,
  leverage, unrealizedPnl, onLevelsChange,
  rangeLow: initialRangeLow,
  rangeHigh: initialRangeHigh,
  longCloseAt: propLongCloseAt,
  shortCloseAt: propShortCloseAt,
  longTrailStop,
  shortTrailStop,
  longAvgEntry,
  shortAvgEntry,
  longScaleCount = 0,
  shortScaleCount = 0,
}: MpChartProps) {
  const [candles,   setCandles]   = useState<Candle[]>([]);
  const [live,      setLive]      = useState(currentPrice);
  const [rangeHigh, setRangeHigh] = useState(initialRangeHigh);
  const [rangeLow,  setRangeLow]  = useState(initialRangeLow);
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef      = useRef<{ type: "high"|"low"; startY: number; startPrice: number; containerH: number } | null>(null);
  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Sync props → state ───────────────────────────────────────────────────
  useEffect(() => { setRangeHigh(initialRangeHigh); }, [initialRangeHigh]);
  useEffect(() => { setRangeLow(initialRangeLow);   }, [initialRangeLow]);
  useEffect(() => { setLive(currentPrice);           }, [currentPrice]);

  // ── Fetch candles ─────────────────────────────────────────────────────────
  const loadCandles = useCallback(async () => {
    try {
      const r = await fetch(`${BASE_URL}api/market/candles?symbol=${symbol}&interval=1&limit=90`);
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) {
        setCandles(data);
        const last = data[data.length - 1]?.close;
        if (last) setLive(last);
      }
    } catch {}
  }, [symbol]);

  useEffect(() => {
    loadCandles();
    pollRef.current = setInterval(loadCandles, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadCandles]);

  // ── Save levels to backend ────────────────────────────────────────────────
  const saveLevels = useCallback(async (high: number, low: number) => {
    setSaving(true);
    try {
      const r = await fetch(`${BASE_URL}api/bot/mp/${symbol}/levels`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rangeHigh: high, rangeLow: low }),
      });
      if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); }
      onLevelsChange?.(symbol, high, low);
    } catch {} finally { setSaving(false); }
  }, [symbol, onLevelsChange]);

  // ── SVG coordinate math ───────────────────────────────────────────────────
  const cur     = live || currentPrice || entryPrice;
  const midP    = (rangeHigh + rangeLow) / 2;
  const chartW  = 360;

  // Effective close prices — use prop if available, else compute from range
  const longCloseAt  = propLongCloseAt  ?? rangeHigh;
  const shortCloseAt = propShortCloseAt ?? rangeLow;

  const allPrices = [
    ...candles.map(c => c.high), ...candles.map(c => c.low),
    rangeHigh * 1.003, rangeLow * 0.997, cur,
    longCloseAt, shortCloseAt,
  ].filter(Boolean);
  const minP   = allPrices.length ? Math.min(...allPrices) : cur * 0.995;
  const maxP   = allPrices.length ? Math.max(...allPrices) : cur * 1.005;
  const rangeP = maxP - minP || 1;

  const chartAreaH = CHART_H - PAD.top - PAD.bottom;

  function toY(price: number): number {
    return PAD.top + (1 - (price - minP) / rangeP) * chartAreaH;
  }
  function toX(i: number): number {
    const usableW = chartW - PAD.left - PAD.right;
    return PAD.left + (i / Math.max(candles.length - 1, 1)) * usableW;
  }
  function yPct(price: number): string {
    return `${(toY(price) / CHART_H) * 100}%`;
  }
  function priceFromYPct(yFrac: number): number {
    const svgY = yFrac * CHART_H;
    return minP + (1 - (svgY - PAD.top) / chartAreaH) * rangeP;
  }

  const linePoints = candles.map((c, i) => `${toX(i).toFixed(1)},${toY(c.close).toFixed(1)}`).join(" ");
  const areaPoints = candles.length > 0
    ? `${toX(0).toFixed(1)},${CHART_H - PAD.bottom} ` + linePoints + ` ${toX(candles.length - 1).toFixed(1)},${CHART_H - PAD.bottom}`
    : "";

  const xEnd   = chartW - PAD.right + 2;
  const xRight = chartW - 2;
  const priceUp = cur >= entryPrice;

  // ── Computed metrics ──────────────────────────────────────────────────────
  const toHighPct  = pct(cur, rangeHigh);
  const toLowPct   = pct(rangeLow, cur);
  const movePct    = pct(entryPrice, cur);
  const rangePctW  = pct(rangeLow, rangeHigh);

  // ── Drag handlers ─────────────────────────────────────────────────────────
  function startDrag(e: React.PointerEvent, type: "high"|"low") {
    if (!containerRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      type,
      startY: e.clientY,
      startPrice: type === "high" ? rangeHigh : rangeLow,
      containerH: containerRef.current.getBoundingClientRect().height,
    };
  }

  function onDrag(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const { type, startY, startPrice, containerH } = dragRef.current;
    const deltaY    = e.clientY - startY;
    const deltaFrac = deltaY / containerH;
    const deltaP    = -deltaFrac * rangeP * (CHART_H / chartAreaH);
    const newPrice  = Math.max(minP * 1.001, Math.min(maxP * 0.999, startPrice + deltaP));

    if (type === "high" && newPrice > rangeLow * 1.001) setRangeHigh(parseFloat(newPrice.toFixed(4)));
    if (type === "low"  && newPrice < rangeHigh * 0.999) setRangeLow(parseFloat(newPrice.toFixed(4)));
  }

  function endDrag() {
    if (!dragRef.current) return;
    dragRef.current = null;
    saveLevels(rangeHigh, rangeLow);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const yHigh       = toY(rangeHigh);
  const yLow        = toY(rangeLow);
  const yMid        = toY(midP);
  const yEntry      = toY(entryPrice);
  const yCur        = toY(cur);
  const yLongClose  = toY(longCloseAt);
  const yShortClose = toY(shortCloseAt);
  const yLongTrail  = longTrailStop  ? toY(longTrailStop)  : null;
  const yShortTrail = shortTrailStop ? toY(shortTrailStop) : null;
  // Entradas promedio por lado (cuando hay escalas difieren del entryPrice original)
  const effectiveLongAvg  = (longAvgEntry  && longAvgEntry  !== entryPrice) ? longAvgEntry  : null;
  const effectiveShortAvg = (shortAvgEntry && shortAvgEntry !== entryPrice) ? shortAvgEntry : null;
  const yLongAvg  = effectiveLongAvg  ? toY(effectiveLongAvg)  : null;
  const yShortAvg = effectiveShortAvg ? toY(effectiveShortAvg) : null;
  // Distancia % al precio real de cierre
  const distLongClose  = longCloseAt  ? pct(cur, longCloseAt)  : 0;
  const distShortClose = shortCloseAt ? pct(shortCloseAt, cur) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>

      {/* ── Chart area ─────────────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        style={{ position: "relative", background: DEEP, userSelect: "none", touchAction: "none" }}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg
          viewBox={`0 0 ${chartW} ${CHART_H}`}
          style={{ width: "100%", height: CHART_H, display: "block" }}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={`ag-${symbol}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={priceUp ? TEAL : RED} stopOpacity="0.15"/>
              <stop offset="100%" stopColor={priceUp ? TEAL : RED} stopOpacity="0.02"/>
            </linearGradient>
            <linearGradient id={`rz-${symbol}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={BLUE} stopOpacity="0.12"/>
              <stop offset="100%" stopColor={BLUE} stopOpacity="0.04"/>
            </linearGradient>
          </defs>

          {/* Range zone fill */}
          <rect x={PAD.left} y={yHigh} width={chartW - PAD.left - PAD.right}
            height={Math.max(0, yLow - yHigh)} fill={`url(#rz-${symbol})`} />

          {/* Price area fill */}
          {areaPoints && <polygon points={areaPoints} fill={`url(#ag-${symbol})`} />}

          {/* Price line */}
          {linePoints && (
            <polyline points={linePoints} fill="none"
              stroke={priceUp ? TEAL : RED} strokeWidth="1.5"
              strokeLinejoin="round" strokeLinecap="round" />
          )}

          {/* ── MID BAND (franja media analizada) ─── */}
          <line x1={PAD.left} y1={yMid} x2={xEnd} y2={yMid}
            stroke={AMBER} strokeWidth="1" strokeDasharray="6 3" opacity="0.7" />
          <text x={xRight} y={yMid + 4} textAnchor="end"
            fontSize="8.5" fontFamily="monospace" fontWeight="700" fill={AMBER} opacity="0.85">
            MID {fmtPrice(midP)}
          </text>

          {/* ── LONG TP line (precio real de cierre) ─── */}
          {!longClosed ? (
            <>
              {/* Línea de rangeHigh como referencia del rango (más tenue) */}
              {Math.abs(longCloseAt - rangeHigh) > rangeHigh * 0.0001 && (
                <line x1={PAD.left} y1={yHigh} x2={xEnd} y2={yHigh}
                  stroke={TEAL} strokeWidth="0.7" strokeDasharray="3 5" opacity="0.35"/>
              )}
              {/* Línea principal: precio real de cierre */}
              <line x1={PAD.left} y1={yLongClose} x2={xEnd} y2={yLongClose}
                stroke={TEAL} strokeWidth="2" strokeDasharray="5 3" opacity="0.98"/>
              <text x={xRight} y={yLongClose - 5} textAnchor="end"
                fontSize="8" fontFamily="monospace" fontWeight="800" fill={TEAL}>
                {fmtPrice(longCloseAt)}
              </text>
              <text x={xRight} y={yLongClose + 7} textAnchor="end"
                fontSize="7.5" fontFamily="monospace" fontWeight="700" fill={TEAL} opacity="0.8">
                L·TP {distLongClose >= 0 ? "▲" : "▼"}{Math.abs(distLongClose).toFixed(2)}%
              </text>
            </>
          ) : (
            <>
              <line x1={PAD.left} y1={yLongClose} x2={xEnd} y2={yLongClose}
                stroke={TEAL} strokeWidth="0.5" strokeDasharray="2 5" opacity="0.3"/>
              <text x={xRight} y={yLongClose + 4} textAnchor="end"
                fontSize="8" fontFamily="monospace" fill={TEAL} opacity="0.5">LONG ✓</text>
            </>
          )}

          {/* ── LONG Trail Stop (protege ganancia acumulada) ─── */}
          {!longClosed && yLongTrail !== null && longTrailStop && (
            <g>
              <line x1={PAD.left} y1={yLongTrail} x2={xEnd} y2={yLongTrail}
                stroke="#FF9500" strokeWidth="1.2" strokeDasharray="3 4" opacity="0.75"/>
              <text x={xRight} y={yLongTrail + 4} textAnchor="end"
                fontSize="7.5" fontFamily="monospace" fontWeight="700" fill="#FF9500" opacity="0.85">
                L·TR {fmtPrice(longTrailStop)}
              </text>
            </g>
          )}

          {/* ── Entry / mid reference ─── */}
          <line x1={PAD.left} y1={yEntry} x2={xEnd} y2={yEntry}
            stroke={WHITE} strokeWidth="0.5" strokeDasharray="2 5" opacity="0.2"/>

          {/* ── Scaled LONG avg entry (se mueve hacia abajo con cada escala) ─── */}
          {yLongAvg !== null && !longClosed && (
            <>
              <line x1={PAD.left} y1={yLongAvg} x2={xEnd} y2={yLongAvg}
                stroke={TEAL} strokeWidth="1" strokeDasharray="3 4" opacity="0.55"/>
              <text x={xRight} y={yLongAvg - 3} textAnchor="end"
                fontSize="7.5" fontFamily="monospace" fontWeight="700" fill={TEAL} opacity="0.75">
                L·avg ×{longScaleCount + 1} {fmtPrice(effectiveLongAvg!)}
              </text>
            </>
          )}
          {/* ── Scaled SHORT avg entry (se mueve hacia arriba con cada escala) ─── */}
          {yShortAvg !== null && !shortClosed && (
            <>
              <line x1={PAD.left} y1={yShortAvg} x2={xEnd} y2={yShortAvg}
                stroke={RED} strokeWidth="1" strokeDasharray="3 4" opacity="0.55"/>
              <text x={xRight} y={yShortAvg + 9} textAnchor="end"
                fontSize="7.5" fontFamily="monospace" fontWeight="700" fill={RED} opacity="0.75">
                S·avg ×{shortScaleCount + 1} {fmtPrice(effectiveShortAvg!)}
              </text>
            </>
          )}

          {/* ── SHORT TP line (precio real de cierre) ─── */}
          {!shortClosed ? (
            <>
              {/* Línea de rangeLow como referencia del rango (más tenue) */}
              {Math.abs(shortCloseAt - rangeLow) > rangeLow * 0.0001 && (
                <line x1={PAD.left} y1={yLow} x2={xEnd} y2={yLow}
                  stroke={RED} strokeWidth="0.7" strokeDasharray="3 5" opacity="0.35"/>
              )}
              {/* Línea principal: precio real de cierre */}
              <line x1={PAD.left} y1={yShortClose} x2={xEnd} y2={yShortClose}
                stroke={RED} strokeWidth="2" strokeDasharray="5 3" opacity="0.98"/>
              <text x={xRight} y={yShortClose - 5} textAnchor="end"
                fontSize="7.5" fontFamily="monospace" fontWeight="700" fill={RED} opacity="0.8">
                S·TP {distShortClose >= 0 ? "▼" : "▲"}{Math.abs(distShortClose).toFixed(2)}%
              </text>
              <text x={xRight} y={yShortClose + 7} textAnchor="end"
                fontSize="8" fontFamily="monospace" fontWeight="800" fill={RED}>
                {fmtPrice(shortCloseAt)}
              </text>
            </>
          ) : (
            <>
              <line x1={PAD.left} y1={yShortClose} x2={xEnd} y2={yShortClose}
                stroke={RED} strokeWidth="0.5" strokeDasharray="2 5" opacity="0.3"/>
              <text x={xRight} y={yShortClose + 4} textAnchor="end"
                fontSize="8" fontFamily="monospace" fill={RED} opacity="0.5">SHORT ✓</text>
            </>
          )}

          {/* ── SHORT Trail Stop (protege ganancia acumulada) ─── */}
          {!shortClosed && yShortTrail !== null && shortTrailStop && (
            <g>
              <line x1={PAD.left} y1={yShortTrail} x2={xEnd} y2={yShortTrail}
                stroke="#FF9500" strokeWidth="1.2" strokeDasharray="3 4" opacity="0.75"/>
              <text x={xRight} y={yShortTrail - 3} textAnchor="end"
                fontSize="7.5" fontFamily="monospace" fontWeight="700" fill="#FF9500" opacity="0.85">
                S·TR {fmtPrice(shortTrailStop)}
              </text>
            </g>
          )}

          {/* ── Current price line ─── */}
          <line x1={PAD.left} y1={yCur} x2={xEnd} y2={yCur}
            stroke={priceUp ? TEAL : RED} strokeWidth="1.2" opacity="0.5"/>
          <circle cx={candles.length > 0 ? toX(candles.length-1) : xEnd}
            cy={yCur} r="3.5" fill={priceUp ? TEAL : RED} stroke={DEEP} strokeWidth="1.5"/>

          {/* ── Time labels ─── */}
          {[0, 0.33, 0.66, 1].map((f, i) => {
            const idx = Math.floor(f * Math.max(candles.length - 1, 0));
            const c = candles[idx];
            if (!c) return null;
            const t = new Date(c.time * 1000).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
            return (
              <text key={i} x={toX(idx)} y={CHART_H - 5} textAnchor="middle"
                fontSize="7" fontFamily="monospace" fill={DIM}>{t}</text>
            );
          })}
        </svg>

        {/* ── Drag handles (overlay) ─── */}
        {!longClosed && (
          <div
            onPointerDown={(e) => startDrag(e, "high")}
            style={{
              position: "absolute", left: 0, top: yPct(rangeHigh),
              transform: "translateY(-50%)",
              width: "calc(100% - 80px)", height: 28,
              cursor: "ns-resize", display: "flex", alignItems: "center",
              justifyContent: "flex-start", paddingLeft: 8, zIndex: 10,
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", gap: 5,
              background: "rgba(0,212,170,0.12)", border: "1.5px dashed #00D4AA",
              borderRadius: 6, padding: "3px 8px",
              pointerEvents: "none",
            }}>
              <span style={{ fontSize: 8, color: TEAL, fontFamily: "monospace", letterSpacing: "0.08em" }}>
                ⠿ LONG TP — arrastrar
              </span>
            </div>
          </div>
        )}
        {!shortClosed && (
          <div
            onPointerDown={(e) => startDrag(e, "low")}
            style={{
              position: "absolute", left: 0, top: yPct(rangeLow),
              transform: "translateY(-50%)",
              width: "calc(100% - 80px)", height: 28,
              cursor: "ns-resize", display: "flex", alignItems: "center",
              justifyContent: "flex-start", paddingLeft: 8, zIndex: 10,
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", gap: 5,
              background: "rgba(242,54,69,0.12)", border: "1.5px dashed #F23645",
              borderRadius: 6, padding: "3px 8px",
              pointerEvents: "none",
            }}>
              <span style={{ fontSize: 8, color: RED, fontFamily: "monospace", letterSpacing: "0.08em" }}>
                ⠿ SHORT TP — arrastrar
              </span>
            </div>
          </div>
        )}

        {/* ── Mid band label on chart ─── */}
        <div style={{
          position: "absolute", left: 8, top: yPct(midP),
          transform: "translateY(-50%)", pointerEvents: "none", zIndex: 5,
        }}>
          <span style={{
            fontSize: 7, fontFamily: "monospace", letterSpacing: "0.12em",
            color: AMBER, background: "rgba(255,149,0,0.08)", padding: "1px 4px", borderRadius: 3,
          }}>FRANJA MEDIA</span>
        </div>

        {/* Save indicator */}
        {(saving || saved) && (
          <div style={{
            position: "absolute", top: 6, right: 84,
            fontSize: 8, fontFamily: "monospace",
            color: saved ? TEAL : AMBER, letterSpacing: "0.1em",
          }}>
            {saved ? "✓ GUARDADO" : "GUARDANDO..."}
          </div>
        )}
      </div>

      {/* ── Metric tiles ─────────────────────────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
        background: "#060614", borderTop: "1px solid #0e0e28",
      }}>
        {/* Precio actual */}
        <div style={{ padding: "9px 6px", textAlign: "center", borderRight: "1px solid #0e0e28" }}>
          <div style={{ fontSize: 7.5, fontFamily: "monospace", letterSpacing: "0.12em", color: DIM, marginBottom: 3 }}>PRECIO</div>
          <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 800, color: priceUp ? TEAL : RED, lineHeight: 1 }}>
            {fmtPrice(cur)}
          </div>
          <div style={{ fontSize: 8, fontFamily: "monospace", color: priceUp ? TEAL : RED, marginTop: 2 }}>
            {movePct >= 0 ? "▲" : "▼"}{Math.abs(movePct).toFixed(3)}%
          </div>
        </div>

        {/* LONG TP */}
        <div style={{
          padding: "9px 6px", textAlign: "center", borderRight: "1px solid #0e0e28",
          background: longClosed ? "rgba(0,212,170,0.06)" : "transparent",
        }}>
          <div style={{ fontSize: 7.5, fontFamily: "monospace", letterSpacing: "0.12em",
            color: longClosed ? TEAL : DIM, marginBottom: 3 }}>
            {longClosed ? "LONG ✓" : "LONG TP"}
          </div>
          {longClosed ? (
            <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 800, color: TEAL }}>
              +{longPnl.toFixed(2)}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 800, color: TEAL }}>
                ▲{toHighPct.toFixed(3)}%
              </div>
              <div style={{ fontSize: 8, fontFamily: "monospace", color: DIM, marginTop: 2 }}>
                {fmtPrice(rangeHigh)}
              </div>
            </>
          )}
        </div>

        {/* SHORT TP */}
        <div style={{
          padding: "9px 6px", textAlign: "center", borderRight: "1px solid #0e0e28",
          background: shortClosed ? "rgba(242,54,69,0.06)" : "transparent",
        }}>
          <div style={{ fontSize: 7.5, fontFamily: "monospace", letterSpacing: "0.12em",
            color: shortClosed ? RED : DIM, marginBottom: 3 }}>
            {shortClosed ? "SHORT ✓" : "SHORT TP"}
          </div>
          {shortClosed ? (
            <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 800, color: shortPnl >= 0 ? TEAL : RED }}>
              {shortPnl >= 0 ? "+" : ""}{shortPnl.toFixed(2)}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 800, color: RED }}>
                ▼{toLowPct.toFixed(3)}%
              </div>
              <div style={{ fontSize: 8, fontFamily: "monospace", color: DIM, marginTop: 2 }}>
                {fmtPrice(rangeLow)}
              </div>
            </>
          )}
        </div>

        {/* PnL + rango */}
        <div style={{ padding: "9px 6px", textAlign: "center" }}>
          <div style={{ fontSize: 7.5, fontFamily: "monospace", letterSpacing: "0.12em", color: DIM, marginBottom: 3 }}>PNL · {leverage}x</div>
          <div style={{ fontSize: 13, fontFamily: "monospace", fontWeight: 800,
            color: unrealizedPnl >= 0 ? TEAL : RED }}>
            {unrealizedPnl >= 0 ? "+" : ""}{unrealizedPnl.toFixed(2)}
          </div>
          <div style={{ fontSize: 8, fontFamily: "monospace", color: AMBER, marginTop: 2 }}>
            rango {rangePctW.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* ── Status bar ───────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "7px 12px", background: "#040412",
        borderTop: "1px solid #0a0a20", borderRadius: "0 0 10px 10px",
      }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%",
              background: TEAL, boxShadow: `0 0 6px ${TEAL}` }} />
            <span style={{ fontSize: 8, fontFamily: "monospace", color: TEAL }}>
              LONG cierra en {fmtPrice(rangeHigh)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%",
              background: RED, boxShadow: `0 0 6px ${RED}` }} />
            <span style={{ fontSize: 8, fontFamily: "monospace", color: RED }}>
              SHORT cierra en {fmtPrice(rangeLow)}
            </span>
          </div>
        </div>
        <span style={{ fontSize: 7.5, fontFamily: "monospace", color: AMBER }}>
          MID {fmtPrice(midP)}
        </span>
      </div>
    </div>
  );
}
