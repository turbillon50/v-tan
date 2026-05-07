import { getKey } from "./api-keys-provider";

const TAG = "[perplexity]";

export type PerplexityResult = {
  ok: boolean;
  answer?: string;
  citations?: string[];
  latencyMs: number;
  error?: string;
};

export async function consultPerplexity(query: string, opts: { maxTokens?: number } = {}): Promise<PerplexityResult> {
  const t0 = Date.now();
  const key = await getKey("perplexity");
  if (!key) return { ok: false, latencyMs: 0, error: "perplexity sin llave activa" };
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          { role: "system", content: "Responde corto, directo, factual. Cita fuentes recientes." },
          { role: "user", content: query },
        ],
        max_tokens: opts.maxTokens ?? 400,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, latencyMs, error: `HTTP ${res.status} ${body.slice(0,150)}` };
    }
    const data = await res.json() as any;
    const answer: string = data?.choices?.[0]?.message?.content ?? "";
    const citations: string[] = Array.isArray(data?.citations) ? data.citations.slice(0, 5) : [];
    console.log(TAG, `query "${query.slice(0,60)}…" → ${latencyMs}ms`);
    return { ok: true, answer, citations, latencyMs };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) };
  }
}
