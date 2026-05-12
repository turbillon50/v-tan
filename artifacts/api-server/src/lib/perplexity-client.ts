import { getKey } from "./api-keys-provider";

/**
 * Cliente Perplexity-style — busca en la web vía `perplexity/sonar-pro`.
 *
 * Desde 2026-05-12 migrado a OpenRouter (Luis: "no quiero pagar lo que no
 * tenga que pagar, OpenRouter es suficiente"). Antes llamaba directo a
 * api.perplexity.ai con PERPLEXITY_API_KEY; ahora usa OpenRouter con el
 * mismo modelo `perplexity/sonar-pro` para consolidar billing y reducir keys.
 *
 * La interfaz pública (`consultPerplexity`, `PerplexityResult`) se mantiene
 * para no romper callers existentes.
 *
 * Fallback: si OPENROUTER_API_KEY no está configurada, intenta la legacy
 * PERPLEXITY_API_KEY (vía api-keys-provider). Si tampoco — error claro.
 */
const TAG = "[perplexity-via-openrouter]";

export type PerplexityResult = {
  ok: boolean;
  answer?: string;
  citations?: string[];
  latencyMs: number;
  error?: string;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PERPLEXITY_DIRECT_URL = "https://api.perplexity.ai/chat/completions";

export async function consultPerplexity(
  query: string,
  opts: { maxTokens?: number } = {},
): Promise<PerplexityResult> {
  const t0 = Date.now();

  // Preferir OpenRouter — es el path moderno y consolidado.
  const orKey = process.env["OPENROUTER_API_KEY"];
  if (orKey) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://tanit.work",
          "X-Title": "Tanit",
        },
        body: JSON.stringify({
          model: "perplexity/sonar-pro",
          messages: [
            { role: "system", content: "Responde corto, directo, factual. Cita fuentes recientes." },
            { role: "user", content: query },
          ],
          max_tokens: opts.maxTokens ?? 400,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, latencyMs, error: `HTTP ${res.status} ${body.slice(0, 150)}` };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      const answer: string = data?.choices?.[0]?.message?.content ?? "";
      // OpenRouter forwards citations en `citations` o en mensaje.annotations cuando
      // el modelo es perplexity. Intentamos ambos.
      const citations: string[] = Array.isArray(data?.citations)
        ? data.citations.slice(0, 5)
        : Array.isArray(data?.choices?.[0]?.message?.annotations)
          ? data.choices[0].message.annotations
              .filter((a: { type?: string }) => a?.type === "url_citation")
              .map((a: { url_citation?: { url?: string } }) => a.url_citation?.url)
              .filter(Boolean)
              .slice(0, 5)
          : [];
      console.log(TAG, `via openrouter query "${query.slice(0, 60)}…" → ${latencyMs}ms`);
      return { ok: true, answer, citations, latencyMs };
    } catch (e) {
      // Caemos a Perplexity directo si OpenRouter peta (transición segura).
      console.warn(TAG, `openrouter fallo, intentando perplexity directo:`, (e as Error).message);
    }
  }

  // Fallback legacy: Perplexity directo con PERPLEXITY_API_KEY (deprecated).
  const key = await getKey("perplexity");
  if (!key) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: "ni OPENROUTER_API_KEY ni PERPLEXITY_API_KEY configuradas",
    };
  }
  try {
    const res = await fetch(PERPLEXITY_DIRECT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
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
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, latencyMs, error: `HTTP ${res.status} ${body.slice(0, 150)}` };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    const answer: string = data?.choices?.[0]?.message?.content ?? "";
    const citations: string[] = Array.isArray(data?.citations) ? data.citations.slice(0, 5) : [];
    console.log(TAG, `via perplexity directo "${query.slice(0, 60)}…" → ${latencyMs}ms`);
    return { ok: true, answer, citations, latencyMs };
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = e as any;
    return { ok: false, latencyMs: Date.now() - t0, error: String(err?.message ?? err) };
  }
}
