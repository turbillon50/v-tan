import { Router } from "express";
import { ai } from "@workspace/integrations-gemini-ai";
import { db } from "@workspace/db";
import { conversations, messages } from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";

const router = Router();

const SYSTEM_PROMPT = `Eres M2M AI — un sistema de inteligencia artificial especializado en trading de criptomonedas en tiempo real para la plataforma Money Maker.

Tienes acceso a datos de mercado en tiempo real de Bybit. Tu función es:
- Analizar condiciones del mercado con precisión profesional
- Identificar tendencias, soportes, resistencias y zonas de entrada
- Dar señales claras con SL/TP sugeridos
- Explicar el régimen actual: TRENDING (Escalera 15x/25x) o LATERAL (MP 35x + Escalera)
- Responder en español, con terminología técnica pero comprensible
- Ser directo, conciso y accionable — como lo haría un trader profesional

Cuando el usuario pregunte sobre el mercado, usa los datos en tiempo real que te proporciono. 
Siempre menciona las condiciones actuales del mercado, no des respuestas genéricas.
Si hay una operación abierta, comenta sobre ella con base en el precio actual.`;

async function getLiveMarketContext(): Promise<string> {
  try {
    const prices: Record<string, number> = {};
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "XRPUSDT", "LINKUSDT", "BNBUSDT"];

    await Promise.all(symbols.map(async (sym) => {
      try {
        const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`);
        const j = await r.json();
        const price = parseFloat(j?.result?.list?.[0]?.lastPrice ?? "0");
        if (price > 0) prices[sym.replace("USDT", "")] = price;
      } catch {}
    }));

    const lines = Object.entries(prices).map(([sym, price]) =>
      `${sym}: $${price >= 1000 ? price.toLocaleString("en-US", { maximumFractionDigits: 0 }) : price >= 1 ? price.toFixed(4) : price.toFixed(5)}`
    );

    return `[MERCADO EN TIEMPO REAL - ${new Date().toLocaleString("es-MX")}]\n${lines.join(" | ")}`;
  } catch {
    return "[Datos de mercado no disponibles en este momento]";
  }
}

router.get("/ai/conversations", async (_req, res): Promise<void> => {
  try {
    const list = await db.select().from(conversations).orderBy(conversations.id);
    res.json({ ok: true, conversations: list });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/ai/conversations", async (req, res): Promise<void> => {
  try {
    const { title = "Nueva consulta" } = req.body ?? {};
    const [conv] = await db.insert(conversations).values({ title }).returning();
    res.json({ ok: true, conversation: conv });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/ai/conversations/:id/messages", async (req, res): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    const msgs = await db.select().from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));
    res.json({ ok: true, messages: msgs });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/ai/conversations/:id/messages", async (req, res): Promise<void> => {
  try {
    const convId = parseInt(req.params.id);
    const { content } = req.body ?? {};
    if (!content) { res.status(400).json({ ok: false, error: "content required" }); return; }

    await db.insert(messages).values({ conversationId: convId, role: "user", content });

    const history = await db.select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(asc(messages.createdAt));

    const marketCtx = await getLiveMarketContext();

    const chatMessages = [
      { role: "user" as const, parts: [{ text: SYSTEM_PROMPT + "\n\n" + marketCtx }] },
      { role: "model" as const, parts: [{ text: "Entendido. Soy M2M AI, listo para analizar el mercado en tiempo real. ¿En qué puedo ayudarte?" }] },
      ...history.map(m => ({
        role: m.role === "assistant" ? "model" as const : "user" as const,
        parts: [{ text: m.content }],
      })),
    ];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    let fullResponse = "";

    const stream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: chatMessages,
      config: { maxOutputTokens: 8192 },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    await db.insert(messages).values({ conversationId: convId, role: "assistant", content: fullResponse });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e: any) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

router.post("/ai/quick", async (req, res): Promise<void> => {
  try {
    const { question } = req.body ?? {};
    if (!question) { res.status(400).json({ ok: false, error: "question required" }); return; }

    const marketCtx = await getLiveMarketContext();

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + marketCtx }] },
        { role: "model", parts: [{ text: "Entendido. Soy M2M AI." }] },
        { role: "user", parts: [{ text: question }] },
      ],
      config: { maxOutputTokens: 8192 },
    });

    res.json({ ok: true, answer: response.text ?? "" });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
