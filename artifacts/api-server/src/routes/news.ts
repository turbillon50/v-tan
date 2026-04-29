import { Router } from "express";

const router = Router();

interface NewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: number;
  sentiment: "positive" | "negative" | "neutral";
  tags: string[];
  imageUrl?: string;
}

function inferSentiment(title: string): "positive" | "negative" | "neutral" {
  const t = title.toLowerCase();
  const positive = ["surge", "rally", "bullish", "high", "gain", "soar", "record", "jump", "rise", "pump", "moon", "sube", "gana", "alcista", "máximo", "récord"];
  const negative = ["crash", "drop", "fall", "bear", "low", "lose", "plunge", "dump", "fear", "panic", "liquidat", "baja", "cae", "bajista", "mínimo", "crisis"];
  const posScore = positive.filter(w => t.includes(w)).length;
  const negScore = negative.filter(w => t.includes(w)).length;
  if (posScore > negScore) return "positive";
  if (negScore > posScore) return "negative";
  return "neutral";
}

async function fetchCryptoCompareNews(categories: string): Promise<NewsItem[]> {
  const apiKey = process.env.CRYPTOCOMPARE_API_KEY ?? "";
  const headers: Record<string, string> = apiKey ? { authorization: `Apikey ${apiKey}` } : {};
  const url = `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=${categories}&sortOrder=latest`;

  const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`CryptoCompare ${r.status}`);
  const data = await r.json() as any;

  return (data.Data ?? []).slice(0, 30).map((item: any, i: number) => ({
    id: String(item.id ?? i),
    title: item.title,
    source: item.source_info?.name ?? item.source ?? "CryptoCompare",
    url: item.url,
    publishedAt: (item.published_on ?? 0) * 1000,
    sentiment: inferSentiment(item.title),
    tags: (item.categories ?? "").split("|").filter(Boolean).slice(0, 4),
    imageUrl: item.imageurl ?? undefined,
  }));
}

async function fetchCryptoPanicNews(currencies: string): Promise<NewsItem[]> {
  const token = process.env.CRYPTOPANIC_API_KEY ?? "";
  if (!token) return [];

  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${token}&currencies=${currencies}&public=true&kind=news`;
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`CryptoPanic ${r.status}`);
  const data = await r.json() as any;

  return (data.results ?? []).slice(0, 20).map((item: any, i: number) => ({
    id: String(item.id ?? i),
    title: item.title,
    source: item.source?.title ?? "CryptoPanic",
    url: item.url,
    publishedAt: new Date(item.published_at).getTime(),
    sentiment: item.votes?.positive > item.votes?.negative ? "positive"
      : item.votes?.negative > item.votes?.positive ? "negative" : "neutral",
    tags: (item.currencies ?? []).map((c: any) => c.code).slice(0, 4),
  }));
}

// ─── Gemini translation ───────────────────────────────────────────────────────
async function translateTitles(items: NewsItem[]): Promise<NewsItem[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return items;
  const englishItems = items.filter(n => !/[áéíóúñ¿¡]/.test(n.title) && /[a-zA-Z]/.test(n.title));
  if (englishItems.length === 0) return items;
  try {
    const titles = englishItems.map(n => n.title).join("\n---\n");
    const prompt = `Traduce los siguientes titulares de noticias de criptomonedas al español mexicano de forma natural y concisa. Devuelve SOLO las traducciones, una por línea, separadas por "---", en el mismo orden. No agregues explicaciones.\n\n${titles}`;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json() as any;
    const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parts = translated.split("---").map((s: string) => s.trim()).filter(Boolean);
    if (parts.length >= englishItems.length) {
      let ti = 0;
      return items.map(n => {
        if (englishItems.includes(n)) {
          const t = parts[ti++];
          return t ? { ...n, title: t } : n;
        }
        return n;
      });
    }
  } catch { /* fallback: return originals */ }
  return items;
}

// ─── GET /news ────────────────────────────────────────────────────────────────
router.get("/news", async (req, res): Promise<void> => {
  const symbol = String(req.query.symbol ?? "BTC");
  const coin = symbol.replace("USDT", "");
  const categories = `${coin},Trading,Market,Blockchain`;
  const currencies = coin;

  const [ccNews, cpNews] = await Promise.allSettled([
    fetchCryptoCompareNews(categories),
    fetchCryptoPanicNews(currencies),
  ]);

  let items: NewsItem[] = [];

  if (ccNews.status === "fulfilled") items = [...items, ...ccNews.value];
  if (cpNews.status === "fulfilled") items = [...items, ...cpNews.value];

  // Deduplicate by title prefix and sort newest first
  const seen = new Set<string>();
  const unique = items.filter(n => {
    const key = n.title.slice(0, 50).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 40);

  // Fallback demo news if nothing loaded
  if (unique.length === 0) {
    const demoNews: NewsItem[] = [
      { id: "d1", title: `Bitcoin holds support at key level as institutions continue accumulation`, source: "CoinDesk", url: "#", publishedAt: Date.now() - 1800000, sentiment: "positive", tags: ["BTC", "Market"] },
      { id: "d2", title: `Ethereum network sees surge in DeFi activity ahead of upgrade`, source: "CoinTelegraph", url: "#", publishedAt: Date.now() - 3600000, sentiment: "positive", tags: ["ETH", "DeFi"] },
      { id: "d3", title: `Crypto market consolidates after volatile week — traders cautious`, source: "The Block", url: "#", publishedAt: Date.now() - 7200000, sentiment: "neutral", tags: ["Market", "Trading"] },
      { id: "d4", title: `Solana TVL reaches new highs as ecosystem projects launch`, source: "Decrypt", url: "#", publishedAt: Date.now() - 10800000, sentiment: "positive", tags: ["SOL", "DeFi"] },
      { id: "d5", title: `SEC delays decision on spot ETF applications once again`, source: "Bloomberg Crypto", url: "#", publishedAt: Date.now() - 14400000, sentiment: "negative", tags: ["BTC", "Regulation"] },
      { id: "d6", title: `Whale alert: Large BTC transfer spotted moving to exchange`, source: "WhaleAlert", url: "#", publishedAt: Date.now() - 18000000, sentiment: "negative", tags: ["BTC", "Whales"] },
      { id: "d7", title: `Analysts predict crypto bull run continuation through Q2`, source: "Messari", url: "#", publishedAt: Date.now() - 21600000, sentiment: "positive", tags: ["Market", "Analysis"] },
      { id: "d8", title: `XRP case update: Ripple files new motion in SEC lawsuit`, source: "CoinDesk", url: "#", publishedAt: Date.now() - 25200000, sentiment: "neutral", tags: ["XRP", "Regulation"] },
    ];
    res.json({ items: demoNews, source: "demo" });
    return;
  }

  const translated = await translateTitles(unique);
  res.json({ items: translated, source: ccNews.status === "fulfilled" ? "live" : "demo" });
});

export default router;
