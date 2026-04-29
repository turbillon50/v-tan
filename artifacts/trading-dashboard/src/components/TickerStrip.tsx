import { useEffect, useRef, useState } from "react";

interface TickerItem {
  sym: string;
  price: number | null;
  change: number | null;
}

const COINS = [
  { id: "bitcoin",  sym: "BTC" },
  { id: "ethereum", sym: "ETH" },
  { id: "solana",   sym: "SOL" },
  { id: "bnb",      sym: "BNB" },
  { id: "ripple",   sym: "XRP" },
];

export function TickerStrip() {
  const [items, setItems] = useState<TickerItem[]>(
    COINS.map(c => ({ sym: c.sym, price: null, change: null }))
  );
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const ids = COINS.map(c => c.id).join(",");
        const r = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
          { cache: "no-store" }
        );
        if (!r.ok) return;
        const d = await r.json();
        setItems(COINS.map(c => ({
          sym: c.sym,
          price: d[c.id]?.usd ?? null,
          change: d[c.id]?.usd_24h_change ?? null,
        })));
      } catch {}
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const fmt = (n: number) => {
    if (n >= 10000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  };

  const doubled = [...items, ...items];

  return (
    <div style={{
      height: 30,
      borderBottom: "1px solid rgba(255,255,255,0.05)",
      background: "#070b13",
      overflow: "hidden",
      display: "flex",
      alignItems: "center",
      position: "relative",
    }}>
      <div style={{
        position: "absolute", left: 0, top: 0, bottom: 0, width: 40,
        background: "linear-gradient(90deg, #070b13, transparent)",
        zIndex: 2, pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", right: 0, top: 0, bottom: 0, width: 40,
        background: "linear-gradient(270deg, #070b13, transparent)",
        zIndex: 2, pointerEvents: "none",
      }} />
      <div ref={trackRef} className="ticker-track" style={{ display: "flex", gap: 0 }}>
        {doubled.map((item, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "0 22px",
            borderRight: "1px solid rgba(255,255,255,0.04)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}>
            <span style={{
              fontFamily: "var(--app-font-mono)", fontSize: 10, fontWeight: 700,
              color: "rgba(255,255,255,0.55)", letterSpacing: "0.08em",
            }}>{item.sym}</span>
            <span style={{
              fontFamily: "var(--app-font-mono)", fontSize: 11, fontWeight: 600,
              color: item.price == null ? "rgba(255,255,255,0.22)" : "#fff",
            }}>
              {item.price == null ? "—" : `$${fmt(item.price)}`}
            </span>
            {item.change != null && (
              <span style={{
                fontFamily: "var(--app-font-mono)", fontSize: 10, fontWeight: 700,
                color: item.change >= 0 ? "#0ECB81" : "#F6465D",
              }}>
                {item.change >= 0 ? "+" : ""}{item.change.toFixed(2)}%
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
