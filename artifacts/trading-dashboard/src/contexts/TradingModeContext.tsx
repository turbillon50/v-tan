import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { BASE_URL } from "@/lib/api";

export interface BotStatus {
  active: boolean;
  liveMode: boolean;
  liveBalance: number | null;
  simBalance: number;
  effectiveBalance: number;
  capitalPct: number | null;
  capitalPercent: number | null;
  testnet: boolean;
  mode: string;
  sessionPnl: number;
  dailyPnl: number;
  dailyStartBalance: number;
  openPositions: Record<string, any>;
  escalonPositionsTarget: number;
  mpActive: boolean;
  [key: string]: any;
}

interface BotCtx {
  bot: BotStatus | null;
  isLive: boolean;
  refresh: () => void;
}

const Ctx = createContext<BotCtx>({ bot: null, isLive: false, refresh: () => {} });

export function TradingModeProvider({ children }: { children: ReactNode }) {
  const [bot, setBot] = useState<BotStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`${BASE_URL}api/bot/status`);
      if (r.ok) setBot(await r.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 500);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // isLive = liveMode configurado (con o sin bot activo) — avisa que el sistema opera con dinero real
  const isLive = !!(bot?.liveMode);

  return (
    <Ctx.Provider value={{ bot, isLive, refresh: fetchStatus }}>
      {children}
    </Ctx.Provider>
  );
}

export const useBotStatus = () => useContext(Ctx);
export const useTradingMode = () => useContext(Ctx);
