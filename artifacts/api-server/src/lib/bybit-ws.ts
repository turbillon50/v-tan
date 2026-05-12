import WebSocket from "ws";

const WS_URL = "wss://stream.bybit.com/v5/public/linear";
const PING_INTERVAL_MS = 20_000;
const RECONNECT_DELAY_MS = 3_000;
const TAG = "[bybit-ws]";

// ── Precio en vivo por símbolo ────────────────────────────────────────────────
const priceCache: Record<string, number> = {};
// ── Funding rate en vivo por símbolo (del ticker WS) ─────────────────────────
const fundingRateCache: Record<string, number> = {};
// ── Última vela (1m) en vivo por símbolo ─────────────────────────────────────
// Formato Bybit klines: [startTime, openPrice, highPrice, lowPrice, closePrice, volume, turnover]
const lastCandle1m: Record<string, any[]> = {};
// ── Detección de cascadas por análisis del buffer de velas 5m ─────────────────
// No depende de APIs externas — usa los datos de kline.5 ya suscritos via WS.
// Una cascada es: volumen de la última vela > 3x el promedio + movimiento > 1.5%

export interface CascadeSignal {
  detected: boolean;
  direction: "DOWN" | "UP" | "NONE"; // DOWN = longs liquidados, UP = shorts liquidados
  magnitude: number;  // % de movimiento en la última vela
  volumeRatio: number; // ratio volumen actual / promedio (ej: 4.2 = 4.2x el promedio)
}

export function detectWsCascade(symbol: string): CascadeSignal {
  const buf = klineBuffer[symbol];
  const NONE: CascadeSignal = { detected: false, direction: "NONE", magnitude: 0, volumeRatio: 0 };
  if (!buf || buf.length < 10) return NONE;

  const recent = buf[buf.length - 1]; // última vela (puede estar abierta)
  const confirmed = buf.slice(0, -1); // velas cerradas
  if (confirmed.length < 5) return NONE;

  // volumen promedio de las últimas 20 velas cerradas (excluyendo la actual)
  const avgVol = confirmed.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, confirmed.length);
  if (avgVol === 0) return NONE;

  const volRatio   = recent.volume / avgVol;
  const priceDelta = recent.open > 0 ? ((recent.close - recent.open) / recent.open) * 100 : 0;
  const magnitude  = Math.abs(priceDelta);

  // Cascada: volumen >3x promedio Y movimiento >1.5% en UNA vela de 5m
  if (volRatio >= 3 && magnitude >= 1.5) {
    return {
      detected:    true,
      direction:   priceDelta < 0 ? "DOWN" : "UP",
      magnitude,
      volumeRatio: volRatio,
    };
  }
  return NONE;
}

/** @deprecated — mantener compatibilidad, retorna vacío */
export function getWsLiquidations(_symbol: string, _windowMs?: number): { longLiqUSDT: number; shortLiqUSDT: number; totalUSDT: number } {
  return { longLiqUSDT: 0, shortLiqUSDT: 0, totalUSDT: 0 };
}
// ── Buffer acumulativo de velas 5m por símbolo (hasta 60 candles) ─────────────
// Usa kline.5 para que el detector de patrones reciba candles de 5min como espera.
const KLINE_BUFFER_SIZE = 60;
const klineBuffer: Record<string, Array<{ open: number; high: number; low: number; close: number; volume: number; startMs: number }>> = {};
// Tracks the last open-candle start timestamp to detect candle identity (avoid false dedup)
const klineOpenCandleStart: Record<string, number> = {};

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let subscribedSymbols: string[] = [];
let _connected = false;

// Listeners de precio en tiempo real — para gestión activa de posiciones
// Cuando llega un nuevo tick de tickers.SYMBOL, notifica a todos los listeners.
type PriceListener = (symbol: string, price: number) => void;
const _priceListeners = new Set<PriceListener>();

export function onPriceUpdate(cb: PriceListener): () => void {
  _priceListeners.add(cb);
  return () => { _priceListeners.delete(cb); };
}

export function isWsConnected(): boolean { return _connected; }

export function getWsPrice(symbol: string): number | null {
  return priceCache[symbol] ?? null;
}

export function getWsFundingRate(symbol: string): number | null {
  return fundingRateCache[symbol] ?? null;
}

export function getWsLastCandle1m(symbol: string): any[] | null {
  return lastCandle1m[symbol] ?? null;
}

/**
 * Retorna el buffer acumulativo de velas 5m (oldest → newest).
 * Retorna null si hay menos de `minCandles` velas acumuladas (periodo de calentamiento).
 */
export function getWsKlineBuffer(symbol: string, minCandles = 30): Array<{ open: number; high: number; low: number; close: number; volume: number }> | null {
  const buf = klineBuffer[symbol];
  if (!buf || buf.length < minCandles) return null;
  return buf;
}

export function startBybitWs(symbols: string[]): void {
  subscribedSymbols = symbols;
  connect();
}

export function stopBybitWs(): void {
  _connected = false;
  if (pingTimer)     { clearInterval(pingTimer);  pingTimer = null; }
  if (reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    ws.removeAllListeners();
    try { ws.terminate(); } catch (_) { /* ignorar si WS aún no conectó */ }
    ws = null;
  }
  console.log(TAG, "WebSocket detenido");
}

function connect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.removeAllListeners(); ws.terminate(); ws = null; }

  console.log(TAG, "Conectando a Bybit WebSocket...");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    _connected = true;
    console.log(TAG, `✅ Conectado — suscribiendo ${subscribedSymbols.length} símbolos`);
    subscribe();
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
    }, PING_INTERVAL_MS);
  });

  let _firstMsg = true;
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (_firstMsg && msg.topic) {
        _firstMsg = false;
        console.log(TAG, `Primera data WS — topic: ${msg.topic} type: ${msg.type} keys: ${Object.keys(msg.data ?? {}).join(",")}`);
      }

      if (msg.op === "subscribe" && msg.success === false) {
        console.error(TAG, `Suscripción fallida: ${msg.ret_msg}`);
      }

      if (!msg.topic) return;

      // ── Ticker — precio en vivo + funding rate ────────────────────────────
      if (msg.topic.startsWith("tickers.")) {
        const data = msg.data;
        if (data?.lastPrice) {
          const sym = msg.topic.replace("tickers.", "");
          const newPrice = parseFloat(data.lastPrice);
          priceCache[sym] = newPrice;
          // Notificar listeners de precio en tiempo real (manage activo)
          if (_priceListeners.size > 0) {
            for (const cb of _priceListeners) {
              try { cb(sym, newPrice); } catch {}
            }
          }
          if (data.fundingRate !== undefined && data.fundingRate !== "") {
            const fr = parseFloat(data.fundingRate);
            if (!isNaN(fr)) fundingRateCache[sym] = fr;
          }
        }
      }

      // ── Kline 1m — para lastCandle1m (compatibilidad existente) ──────────
      if (msg.topic.startsWith("kline.1.")) {
        const kArr = msg.data;
        if (Array.isArray(kArr) && kArr.length > 0) {
          const sym = msg.topic.replace("kline.1.", "");
          const k = kArr[0];
          lastCandle1m[sym] = [
            String(k.start),
            String(k.open),
            String(k.high),
            String(k.low),
            String(k.close),
            String(k.volume),
            String(k.turnover),
          ];
        }
      }

      // ── Liquidaciones en tiempo real — DEPRECATED ────────────────────────
      // Se reemplazó por detectWsCascade() que analiza klineBuffer (5m candles).
      // El topic "liquidation." sigue suscrito en el server pero ya no se procesa.

      // ── Kline 5m — buffer de velas para pattern-detector ─────────────────
      if (msg.topic.startsWith("kline.5.")) {
        const kArr = msg.data;
        if (Array.isArray(kArr) && kArr.length > 0) {
          const sym = msg.topic.replace("kline.5.", "");
          const k = kArr[0];
          const startMs = typeof k.start === "number" ? k.start : parseInt(k.start ?? "0");
          const candle = {
            open:    parseFloat(k.open),
            high:    parseFloat(k.high),
            low:     parseFloat(k.low),
            close:   parseFloat(k.close),
            volume:  parseFloat(k.volume),
            startMs,
          };
          if (!klineBuffer[sym]) klineBuffer[sym] = [];
          const buf = klineBuffer[sym];

          if (k.confirm === true) {
            // Vela confirmada/cerrada — agregar solo si es una nueva vela (por startMs)
            const lastInBuf = buf[buf.length - 1];
            if (!lastInBuf || lastInBuf.startMs !== startMs) {
              // Reemplazar la última vela abierta (si tiene el mismo startMs en buf) o agregar
              if (lastInBuf && lastInBuf.startMs === startMs) {
                buf[buf.length - 1] = candle;
              } else {
                buf.push(candle);
              }
              if (buf.length > KLINE_BUFFER_SIZE) buf.shift();
            }
            delete klineOpenCandleStart[sym];
          } else {
            // Vela abierta — actualizar si es el mismo startMs, agregar si es nueva
            const prevOpenStart = klineOpenCandleStart[sym] ?? -1;
            if (buf.length === 0 || prevOpenStart !== startMs) {
              // Nueva vela abierta — agregar al buffer y registrar su start
              buf.push(candle);
              klineOpenCandleStart[sym] = startMs;
              if (buf.length > KLINE_BUFFER_SIZE) buf.shift();
            } else {
              // Misma vela abierta — actualizar la última entrada
              buf[buf.length - 1] = candle;
            }
          }
        }
      }
    } catch {}
  });

  ws.on("close", () => {
    _connected = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    console.log(TAG, "Conexión cerrada — reconectando en 3s...");
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err: Error) => {
    console.error(TAG, "Error WS:", err.message);
    ws?.terminate();
  });
}

function subscribe(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const tickerTopics  = subscribedSymbols.map(s => `tickers.${s}`);
  const kline1Topics  = subscribedSymbols.map(s => `kline.1.${s}`);
  const kline5Topics  = subscribedSymbols.map(s => `kline.5.${s}`);
  const BATCH = 10;
  for (let i = 0; i < tickerTopics.length; i += BATCH) {
    const batch = tickerTopics.slice(i, i + BATCH);
    ws.send(JSON.stringify({ op: "subscribe", args: batch }));
  }
  console.log(TAG, `📡 Suscrito a ${tickerTopics.length} tickers en lotes de ${BATCH}`);

  for (let i = 0; i < kline1Topics.length; i += BATCH) {
    const batch = kline1Topics.slice(i, i + BATCH);
    ws.send(JSON.stringify({ op: "subscribe", args: batch }));
  }
  console.log(TAG, `📡 Suscrito a ${kline1Topics.length} klines 1m en lotes de ${BATCH}`);

  for (let i = 0; i < kline5Topics.length; i += BATCH) {
    const batch = kline5Topics.slice(i, i + BATCH);
    ws.send(JSON.stringify({ op: "subscribe", args: batch }));
  }
  console.log(TAG, `📡 Suscrito a ${kline5Topics.length} klines 5m en lotes de ${BATCH}`);
}
