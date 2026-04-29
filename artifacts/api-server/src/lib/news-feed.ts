/**
 * Noticias cripto en tiempo real desde múltiples feeds RSS.
 * Fuentes: CoinDesk RSS (primaria) + Google News RSS (fallback/suplemento).
 * Cache 15 minutos para evitar saturar los feeds.
 */

interface NewsItem {
  title: string;
  pubDate: string;
  source: string;
}

interface NewsCache {
  items: NewsItem[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos (alinhado con SENTIMENT_CACHE_TTL)
const generalCache: NewsCache = { items: [], fetchedAt: 0 };
const coinCache: Record<string, NewsCache> = {};

// ── CoinDesk RSS — feed de noticias cripto de alta calidad (sin API key) ──────
const COINDESK_RSS_URL = "https://www.coindesk.com/arc/outboundfeeds/rss/";
const coindeskCache: NewsCache = { items: [], fetchedAt: 0 };

async function fetchCoinDeskRSS(): Promise<NewsItem[]> {
  try {
    const res = await fetch(COINDESK_RSS_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSS(xml).slice(0, 12).map(item => ({ ...item, source: "CoinDesk" }));
  } catch {
    return [];
  }
}

/** Noticias CoinDesk — cache 15 min. Fuente primaria de alta calidad. */
async function getCoinDeskNews(): Promise<NewsItem[]> {
  if (Date.now() - coindeskCache.fetchedAt < CACHE_TTL_MS) return coindeskCache.items;
  const items = await fetchCoinDeskRSS();
  coindeskCache.items = items;
  coindeskCache.fetchedAt = Date.now();
  return items;
}

const COIN_ALIASES: Record<string, string[]> = {
  BTC:  ["bitcoin", "BTC"],
  ETH:  ["ethereum", "ETH"],
  SOL:  ["solana", "SOL"],
  XRP:  ["ripple", "XRP"],
  DOGE: ["dogecoin", "DOGE"],
  ADA:  ["cardano", "ADA"],
  AVAX: ["avalanche", "AVAX"],
  LINK: ["chainlink", "LINK"],
  DOT:  ["polkadot", "DOT"],
  MATIC:["polygon", "MATIC"],
  TON:  ["toncoin", "TON"],
  TRX:  ["tron", "TRX"],
  SUI:  ["sui network", "SUI"],
  BCH:  ["bitcoin cash", "BCH"],
  LTC:  ["litecoin", "LTC"],
  ATOM: ["cosmos", "ATOM"],
};

function parseRSS(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title   = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) ?? /<title>(.*?)<\/title>/.exec(block))?.[1]?.trim() ?? "";
    const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(block))?.[1]?.trim() ?? "";
    const source  = (/<source[^>]*>(.*?)<\/source>/.exec(block))?.[1]?.trim() ?? "Google News";
    if (title) items.push({ title, pubDate, source });
  }
  return items;
}

async function fetchRSS(query: string): Promise<NewsItem[]> {
  try {
    const q = encodeURIComponent(query);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSS(xml).slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Noticias generales de cripto — combina CoinDesk RSS (primaria) + Google News (suplemento).
 * Cache 15 min.
 */
export async function getGeneralCryptoNews(): Promise<NewsItem[]> {
  if (Date.now() - generalCache.fetchedAt < CACHE_TTL_MS) return generalCache.items;

  // CoinDesk como fuente primaria — noticias cripto de alta calidad
  const [coindeskItems, googleItems] = await Promise.all([
    getCoinDeskNews(),
    fetchRSS("crypto bitcoin market price today"),
  ]);

  // Combinar y deduplicar por título
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const item of [...coindeskItems, ...googleItems]) {
    const key = item.title.slice(0, 60).toLowerCase();
    if (!seen.has(key)) { seen.add(key); merged.push(item); }
  }

  const items = merged.slice(0, 12);
  generalCache.items = items;
  generalCache.fetchedAt = Date.now();
  return items;
}

/**
 * Noticias específicas de una moneda — busca en CoinDesk + Google News.
 * Cache 15 min por coin.
 */
export async function getCoinNews(symbol: string): Promise<NewsItem[]> {
  const coin = symbol.replace("USDT", "");
  const cached = coinCache[coin];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.items;

  const aliases = COIN_ALIASES[coin] ?? [coin];
  const query = aliases.join(" OR ") + " crypto price";

  // Fetch Google News específico + filtrar CoinDesk general por aliases
  const [googleItems, coindeskAll] = await Promise.all([
    fetchRSS(query),
    getCoinDeskNews(),
  ]);

  // Filtrar CoinDesk por mención del coin en el título
  const lowerAliases = aliases.map(a => a.toLowerCase());
  const coindeskFiltered = coindeskAll.filter(item =>
    lowerAliases.some(a => item.title.toLowerCase().includes(a))
  );

  // Combinar y deduplicar
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const item of [...coindeskFiltered, ...googleItems]) {
    const key = item.title.slice(0, 60).toLowerCase();
    if (!seen.has(key)) { seen.add(key); merged.push(item); }
  }

  const items = merged.slice(0, 8);
  coinCache[coin] = { items, fetchedAt: Date.now() };
  return items;
}

/** Resumen de noticias para el prompt de Tanit */
export async function getNewsSummaryForTanit(): Promise<string> {
  const news = await getGeneralCryptoNews();
  if (!news.length) return "";
  const lines = news.slice(0, 6).map(n => `• ${n.title}`).join("\n");
  return `\n📰 NOTICIAS CRIPTO (últimos ${Math.round(CACHE_TTL_MS/60000)} min):\n${lines}`;
}

/** Resumen de noticias de una moneda para el análisis de señal */
export async function getCoinNewsSummary(symbol: string): Promise<string> {
  const news = await getCoinNews(symbol);
  if (!news.length) return "";
  return news.slice(0, 3).map(n => n.title).join(" | ");
}

// ── SENTIMENT SCORING ─────────────────────────────────────────────────────────
// Cache compartido con CACHE_TTL_MS (15 min)

const SENTIMENT_CACHE_TTL = CACHE_TTL_MS;
const sentimentCache: Record<string, { score: number; cachedAt: number }> = {};

const STRONG_BULLISH = ["surge", "rally", "breakout", "all-time high", "ath", "bullish", "upgrade", "partnership", "launch", "adoption", "etf approved", "institutional", "listing", "moon", "pump", "skyrocket"];
const MODERATE_BULLISH = ["rise", "gain", "positive", "recover", "rebound", "up", "increase", "growth", "strong", "higher", "accumulate", "buy"];
const STRONG_BEARISH = ["crash", "hack", "hacked", "ban", "banned", "lawsuit", "dump", "fraud", "exploit", "rug", "scam", "collapse", "plunge", "sink", "SEC", "arrest", "bankrupt"];
const MODERATE_BEARISH = ["drop", "fall", "decline", "concern", "warning", "risk", "fear", "uncertainty", "sell", "lower", "weak", "bearish", "down"];

function scoreHeadlines(headlines: string[]): number {
  let total = 0;
  for (const title of headlines) {
    const lower = title.toLowerCase();
    let score = 0;
    for (const kw of STRONG_BULLISH)   if (lower.includes(kw)) score += 5;
    for (const kw of MODERATE_BULLISH) if (lower.includes(kw)) score += 2;
    for (const kw of STRONG_BEARISH)   if (lower.includes(kw)) score -= 5;
    for (const kw of MODERATE_BEARISH) if (lower.includes(kw)) score -= 2;
    total += Math.max(-5, Math.min(5, score));
  }
  return Math.max(-10, Math.min(10, total));
}

/**
 * Retorna un score de sentimiento de noticias para el símbolo.
 * Rango: -10 (muy negativo) a +10 (muy positivo). 0 = neutro/sin noticias.
 * Cache de 15 minutos por símbolo.
 */
export async function getNewsSentimentScore(symbol: string): Promise<number> {
  const coin = symbol.replace("USDT", "");
  const cached = sentimentCache[coin];
  if (cached && Date.now() - cached.cachedAt < SENTIMENT_CACHE_TTL) return cached.score;

  try {
    const news = await getCoinNews(symbol);
    if (!news.length) {
      sentimentCache[coin] = { score: 0, cachedAt: Date.now() };
      return 0;
    }
    const headlines = news.slice(0, 5).map(n => n.title);
    const score = scoreHeadlines(headlines);
    sentimentCache[coin] = { score, cachedAt: Date.now() };
    return score;
  } catch {
    return 0;
  }
}

/**
 * Resumen de sentimiento por símbolo para el prompt de Tanit.
 */
export function getNewsSentimentSummary(symbols: string[]): string {
  const lines = symbols
    .map(s => {
      const coin = s.replace("USDT", "");
      const c = sentimentCache[coin];
      if (!c || c.score === 0) return null;
      const emoji = c.score >= 5 ? "🟢" : c.score >= 2 ? "🔵" : c.score <= -5 ? "🔴" : "🟡";
      return `${emoji} ${coin}: ${c.score >= 0 ? "+" : ""}${c.score} noticias`;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join(" | ") : "Sin señal de noticias";
}
