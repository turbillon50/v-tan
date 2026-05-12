/**
 * Self-diagnose tool — Tanit puede preguntar a sus propios servicios si están
 * vivos y con cuota disponible. Evita que afirme cosas falsas tipo "uso
 * Perplexity" cuando la key existe pero ya no tiene saldo.
 *
 * Para cada servicio retorna:
 *   { name, connected, ready, error? }
 * - connected: la env var/credential está configurada
 * - ready: la última invocación de prueba funcionó (no quota exhausted, no
 *   401, etc.)
 * - error: texto si ready=false
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { isTestnet, bybitPublic, getBybitBalance } from "../../lib/bybit-auth";

interface ServiceStatus {
  name: string;
  connected: boolean;
  ready: boolean;
  error: string | null;
  detail?: string;
}

async function checkPerplexity(): Promise<ServiceStatus> {
  // Desde 2026-05-12 preferimos OpenRouter (consolidado) sobre Perplexity directo.
  const orKey = process.env["OPENROUTER_API_KEY"];
  if (orKey) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://tanit.work",
          "X-Title": "Tanit",
        },
        body: JSON.stringify({
          model: "perplexity/sonar-pro",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) return { name: "perplexity", connected: true, ready: true, error: null, detail: "via OpenRouter" };
      const t = await r.text();
      return { name: "perplexity", connected: true, ready: false, error: `OpenRouter HTTP ${r.status}: ${t.slice(0, 100)}` };
    } catch (e) {
      return { name: "perplexity", connected: false, ready: false, error: `OpenRouter: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Fallback legacy: Perplexity directo.
  const key = process.env["PERPLEXITY_API_KEY"];
  if (!key) return { name: "perplexity", connected: false, ready: false, error: "ni OPENROUTER_API_KEY ni PERPLEXITY_API_KEY configuradas" };
  try {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return { name: "perplexity", connected: true, ready: true, error: null, detail: "via Perplexity directo (legacy)" };
    const t = await r.text();
    const lower = t.toLowerCase();
    let why = `HTTP ${r.status}`;
    if (lower.includes("insufficient_quota") || lower.includes("exceeded your current quota")) {
      why = "cuota agotada / sin saldo — migra a OpenRouter o recarga en perplexity.ai/settings/api";
    } else if (r.status === 401) {
      why = "key inválida o revocada";
    }
    return { name: "perplexity", connected: true, ready: false, error: why };
  } catch (e) {
    return { name: "perplexity", connected: true, ready: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkGemini(): Promise<ServiceStatus> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) return { name: "gemini", connected: false, ready: false, error: "GEMINI_API_KEY no configurada" };
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 1 } }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (r.ok) return { name: "gemini", connected: true, ready: true, error: null };
    const j = await r.json().catch(() => ({}));
    const msg = (j as any)?.error?.message ?? `HTTP ${r.status}`;
    return { name: "gemini", connected: true, ready: false, error: String(msg).slice(0, 150) };
  } catch (e) {
    return { name: "gemini", connected: true, ready: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkBybit(): Promise<ServiceStatus> {
  try {
    const t = await bybitPublic("GET", "/v5/market/time", {});
    if (t?.retCode === 0) {
      const b = await getBybitBalance();
      const mode = isTestnet() ? "TESTNET" : "MAINNET";
      const equity = b?.equity ?? 0;
      const avail = b?.available ?? 0;
      return {
        name: "bybit",
        connected: true,
        ready: true,
        error: null,
        detail: `${mode} · equity $${equity.toFixed(2)} · available USDT $${avail.toFixed(4)}`,
      };
    }
    return { name: "bybit", connected: true, ready: false, error: `retCode=${t?.retCode} ${t?.retMsg ?? ""}` };
  } catch (e) {
    return { name: "bybit", connected: true, ready: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkGithub(): Promise<ServiceStatus> {
  const key = process.env["GITHUB_TOKEN"];
  if (!key) return { name: "github", connected: false, ready: false, error: "GITHUB_TOKEN no configurada" };
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j = (await r.json()) as any;
      return { name: "github", connected: true, ready: true, error: null, detail: `login=${j.login}` };
    }
    return { name: "github", connected: true, ready: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { name: "github", connected: true, ready: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkRailway(): Promise<ServiceStatus> {
  const key = process.env["RAILWAY_API_TOKEN"];
  if (!key) return { name: "railway", connected: false, ready: false, error: "RAILWAY_API_TOKEN no configurada" };
  try {
    const r = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ me { email } }" }),
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j = (await r.json()) as any;
      if (j?.data?.me?.email) {
        return { name: "railway", connected: true, ready: true, error: null, detail: `account ${j.data.me.email}` };
      }
      return { name: "railway", connected: true, ready: false, error: "Not Authorized" };
    }
    return { name: "railway", connected: true, ready: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { name: "railway", connected: true, ready: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkVercel(): Promise<ServiceStatus> {
  const key = process.env["VERCEL_TOKEN"];
  if (!key) return { name: "vercel", connected: false, ready: false, error: "VERCEL_TOKEN no configurada" };
  try {
    const r = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) return { name: "vercel", connected: true, ready: true, error: null };
    return { name: "vercel", connected: true, ready: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { name: "vercel", connected: true, ready: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkOpenAI(): Promise<ServiceStatus> {
  const key = process.env["OPENAI_API_KEY"];
  if (!key) return { name: "openai", connected: false, ready: false, error: "OPENAI_API_KEY no configurada" };
  try {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) return { name: "openai", connected: true, ready: true, error: null };
    if (r.status === 429 || r.status === 402) {
      return { name: "openai", connected: true, ready: false, error: "cuota agotada / sin saldo" };
    }
    return { name: "openai", connected: true, ready: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { name: "openai", connected: true, ready: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const consultarServiciosActivos = createTool({
  id: "consultar_servicios_activos",
  description:
    "Verifica EN VIVO qué servicios externos están conectados Y funcionando (no solo si tienen key configurada). Hace ping real a cada uno y reporta connected + ready + error. Úsala SIEMPRE antes de prometer usar un servicio (Perplexity, OpenAI, Gemini, Bybit, GitHub, Railway, Vercel). Si un servicio reporta ready=false, NO lo prometas — dile a Luis exactamente qué falta (cuota, key, etc.).",
  inputSchema: z.object({}).optional(),
  outputSchema: z.object({
    services: z.array(
      z.object({
        name: z.string(),
        connected: z.boolean(),
        ready: z.boolean(),
        error: z.string().nullable(),
        detail: z.string().optional(),
      }),
    ),
    summary: z.string(),
  }),
  execute: async () => {
    const results = await Promise.all([
      checkBybit(),
      checkGemini(),
      checkPerplexity(),
      checkOpenAI(),
      checkGithub(),
      checkRailway(),
      checkVercel(),
    ]);
    const okCount = results.filter((s) => s.ready).length;
    const badCount = results.filter((s) => s.connected && !s.ready).length;
    const missingCount = results.filter((s) => !s.connected).length;
    const summary = `OK: ${okCount}/${results.length}. Con problema: ${badCount}. Sin configurar: ${missingCount}.`;
    return { services: results, summary };
  },
});

export const diagnoseTools = {
  consultarServiciosActivos,
};
