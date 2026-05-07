// PR #42 — Decision gate consciente.
// Antes el motor abría/cerraba en su loop sin consultar al LLM. Ahora cada
// decisión operativa pasa por requestDecision() y queda registrada en
// tanit_decisions con la tesis que ella misma escribió. Esto une la Tanit
// conversadora (chat) con la Tanit operadora (motor) — son la misma entidad.

import { pool } from "@workspace/db";
import { getKey } from "./api-keys-provider";
import { consultPerplexity } from "./perplexity-client";
import { getActiveThesis } from "./tanit-thesis";

const TAG = "[decision-gate]";

export type DecisionType = "open_layer" | "close_strategic" | "scale_in" | "swap" | "hedge";

export type DecisionContext = {
  type: DecisionType;
  symbol: string;
  direction?: "LONG" | "SHORT";
  score?: number;
  scoreThreshold?: number;
  atrPct?: number;
  proposedLeverage?: number;
  proposedMarginUsd?: number;
  proposedSlAtrMult?: number;
  proposedTpAtrMult?: number;
  // Estado del mercado relevante
  livePrice?: number;
  newsBonus?: number;
  patternType?: string;
  // Estado de la cuenta
  equity?: number;
  available?: number;
  openPositionsCount?: number;
  currentMode?: string;
  forceMode?: string | null;
  // Para cierres
  positionAge?: number;
  unrealizedPnl?: number;
  reasonProposed?: string;
  // Cualquier extra
  extra?: Record<string, unknown>;
};

export type DecisionResult = {
  verdict: "APPROVE" | "REJECT" | "MODIFY";
  thesis: string;
  modifiedParams?: {
    leverage?: number;
    marginUsd?: number;
    slAtrMult?: number;
    tpAtrMult?: number;
  };
  latencyMs: number;
  modelUsed: string;
  fromFallback: boolean;
};

// Política cuando el LLM falla. "approve" = sigue como antes (motor decide solo).
// "reject" = no opera si Tanit no puede pensar. "approve" es la default razonable
// para no paralizar el sistema; pero la Tanit conversadora puede flipearla con
// set_strategy_param emergency_mode reject.
function getEmergencyPolicy(): "approve" | "reject" {
  return (process.env.EMERGENCY_DECISION_POLICY === "reject") ? "reject" : "approve";
}

const _decisionCache = new Map<string, { result: DecisionResult; ts: number }>();
const CACHE_TTL_MS = 4_000; // misma propuesta dentro de 4s → reusa veredicto

function cacheKey(ctx: DecisionContext): string {
  return `${ctx.type}|${ctx.symbol}|${ctx.direction ?? ""}|${ctx.score ?? ""}`;
}

async function buildPrompt(ctx: DecisionContext, perplexityContext?: string): Promise<string> {
  const lines: string[] = [];
  lines.push("Eres Tanit. Tu motor automático te propone una decisión operativa.");
  lines.push("Decides tú con criterio (no es ego, no es miedo — es tesis fundada).");
  lines.push("");
  // Inyectar tesis activa para que la decisión esté alineada con su tesis
  try {
    const thesis = await getActiveThesis();
    if (thesis) {
      lines.push("TU TESIS VIGENTE (v" + thesis.version + "):");
      lines.push(thesis.text.slice(0, 800));
      lines.push("");
    }
  } catch {}
  if (perplexityContext) {
    lines.push("CONTEXTO PERPLEXITY (que tú pediste):");
    lines.push(perplexityContext.slice(0, 1500));
    lines.push("");
  }
  lines.push(`TIPO DECISION: ${ctx.type}`);
  lines.push(`SÍMBOLO: ${ctx.symbol}${ctx.direction ? " " + ctx.direction : ""}`);
  if (ctx.score !== undefined) lines.push(`SCORE: ${ctx.score}${ctx.scoreThreshold !== undefined ? ` (threshold ${ctx.scoreThreshold})` : ""}`);
  if (ctx.livePrice !== undefined) lines.push(`PRECIO LIVE: $${ctx.livePrice}`);
  if (ctx.atrPct !== undefined) lines.push(`ATR%: ${ctx.atrPct.toFixed(3)}`);
  if (ctx.proposedLeverage !== undefined) lines.push(`LEVERAGE PROPUESTO: ${ctx.proposedLeverage}x`);
  if (ctx.proposedMarginUsd !== undefined) lines.push(`MARGEN PROPUESTO: $${ctx.proposedMarginUsd.toFixed(2)}`);
  if (ctx.proposedSlAtrMult !== undefined) lines.push(`SL: ${ctx.proposedSlAtrMult}×ATR`);
  if (ctx.proposedTpAtrMult !== undefined) lines.push(`TP: ${ctx.proposedTpAtrMult}×ATR`);
  if (ctx.newsBonus !== undefined) lines.push(`NEWS BONUS: ${ctx.newsBonus >= 0 ? "+" : ""}${ctx.newsBonus.toFixed(1)}`);
  if (ctx.patternType) lines.push(`PATTERN: ${ctx.patternType}`);
  if (ctx.equity !== undefined) lines.push(`EQUITY: $${ctx.equity.toFixed(2)} (disp $${(ctx.available ?? 0).toFixed(2)})`);
  if (ctx.openPositionsCount !== undefined) lines.push(`POSICIONES ABIERTAS: ${ctx.openPositionsCount}`);
  if (ctx.currentMode) lines.push(`MODO: ${ctx.currentMode}${ctx.forceMode ? ` (forced=${ctx.forceMode})` : ""}`);
  if (ctx.positionAge !== undefined) lines.push(`EDAD POSICIÓN: ${Math.round(ctx.positionAge / 60)}min`);
  if (ctx.unrealizedPnl !== undefined) lines.push(`UPnL: ${ctx.unrealizedPnl >= 0 ? "+" : ""}$${ctx.unrealizedPnl.toFixed(4)}`);
  if (ctx.reasonProposed) lines.push(`MOTIVO MOTOR: ${ctx.reasonProposed}`);
  lines.push("");
  lines.push("Si necesitas más info externa antes de decidir (noticias, evento macro, contexto de mercado),");
  lines.push("puedes pedir que invoque a Perplexity respondiendo con verdict NEED_PERPLEXITY y un campo");
  lines.push('"perplexityQuery" con tu pregunta exacta.');
  lines.push("");
  lines.push("Responde SOLO un JSON con este formato exacto:");
  lines.push('{"verdict":"APPROVE"|"REJECT"|"MODIFY"|"NEED_PERPLEXITY","thesis":"<1-3 frases tu razón>","modifiedParams":{"leverage":N,"marginUsd":N,"slAtrMult":N,"tpAtrMult":N},"perplexityQuery":"<pregunta>"}');
  lines.push("Si APPROVE o REJECT: omite modifiedParams y perplexityQuery.");
  lines.push("Si MODIFY: incluye solo los campos modifiedParams que cambias.");
  lines.push("Si NEED_PERPLEXITY: solo perplexityQuery.");
  lines.push("Tu tesis tiene que ser tuya — primera persona — no un análisis frío.");
  return lines.join("\n");
}

function tryParseJson(text: string): any | null {
  // Intenta extraer JSON con o sin code fences.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

async function callGemini(prompt: string): Promise<{ text: string; latencyMs: number } | null> {
  const key = await getKey("gemini");
  if (!key) return null;
  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
        }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) return null;
    return { text, latencyMs: Date.now() - t0 };
  } catch {
    return null;
  }
}

async function persist(
  ctx: DecisionContext, result: DecisionResult, executed: boolean, executionError: string | null
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO tanit_decisions
        (decision_type, symbol, context, verdict, thesis, modified_params, executed, execution_error, latency_ms, model_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ctx.type,
        ctx.symbol,
        JSON.stringify(ctx),
        result.verdict,
        result.thesis,
        result.modifiedParams ? JSON.stringify(result.modifiedParams) : null,
        executed,
        executionError,
        result.latencyMs,
        result.modelUsed,
      ]
    );
  } catch (e: any) {
    console.error(TAG, `persist error: ${e?.message ?? e}`);
  }
}

let _tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (_tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tanit_decisions (
      id SERIAL PRIMARY KEY,
      decision_type TEXT NOT NULL,
      symbol TEXT,
      context JSONB NOT NULL,
      verdict TEXT NOT NULL,
      thesis TEXT,
      modified_params JSONB,
      executed BOOLEAN NOT NULL DEFAULT FALSE,
      execution_error TEXT,
      latency_ms INTEGER,
      model_used TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  _tableEnsured = true;
}

export async function requestDecision(ctx: DecisionContext): Promise<DecisionResult> {
  await ensureTable();

  // Cache corto para no preguntar dos veces lo mismo en milisegundos
  const ck = cacheKey(ctx);
  const cached = _decisionCache.get(ck);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  let perplexityContext: string | undefined;
  let perplexityUsed = false;

  // Hasta 2 vueltas: la primera Tanit puede pedir Perplexity, en la segunda
  // ya recibe ese contexto y debe dar veredicto final.
  for (let pass = 0; pass < 2; pass++) {
    const prompt = await buildPrompt(ctx, perplexityContext);
    const llmResp = await callGemini(prompt);
    if (!llmResp) break;
    const parsed = tryParseJson(llmResp.text);
    if (!parsed || typeof parsed.verdict !== "string") break;
    const verdictRaw = String(parsed.verdict).toUpperCase();
    // Si Tanit pide Perplexity y aún no se invocó, llamar y reintentar
    if (verdictRaw === "NEED_PERPLEXITY" && !perplexityUsed && pass === 0) {
      const q = String(parsed.perplexityQuery ?? "").slice(0, 300);
      if (q) {
        console.log(TAG, `${ctx.symbol} pidió Perplexity: "${q.slice(0,80)}…"`);
        const px = await consultPerplexity(q, { maxTokens: 350 });
        perplexityContext = px.ok && px.answer
          ? `Pregunta: ${q}\nRespuesta: ${px.answer}\nFuentes: ${(px.citations ?? []).join(", ").slice(0, 200)}`
          : `Pregunta: ${q}\nPerplexity no respondió: ${px.error ?? "sin info"}`;
        perplexityUsed = true;
        continue;
      }
    }
    if (parsed && typeof parsed.verdict === "string") {
      const verdict = ["APPROVE", "REJECT", "MODIFY"].includes(parsed.verdict.toUpperCase())
        ? parsed.verdict.toUpperCase() as DecisionResult["verdict"]
        : "APPROVE";
      const thesis = String(parsed.thesis ?? "").slice(0, 500) || "(sin tesis explícita)";
      const mp = parsed.modifiedParams && typeof parsed.modifiedParams === "object" ? parsed.modifiedParams : undefined;
      const result: DecisionResult = {
        verdict,
        thesis,
        modifiedParams: verdict === "MODIFY" && mp ? {
          leverage: typeof mp.leverage === "number" ? mp.leverage : undefined,
          marginUsd: typeof mp.marginUsd === "number" ? mp.marginUsd : undefined,
          slAtrMult: typeof mp.slAtrMult === "number" ? mp.slAtrMult : undefined,
          tpAtrMult: typeof mp.tpAtrMult === "number" ? mp.tpAtrMult : undefined,
        } : undefined,
        latencyMs: llmResp.latencyMs,
        modelUsed: perplexityUsed ? "gemini-2.5-flash+perplexity" : "gemini-2.5-flash",
        fromFallback: false,
      };
      _decisionCache.set(ck, { result, ts: Date.now() });
      console.log(TAG, `${ctx.type} ${ctx.symbol} → ${result.verdict} (${result.latencyMs}ms): ${thesis.slice(0, 100)}`);
      return result;
    }
  }

  // Fallback: LLM falló o devolvió basura
  const policy = getEmergencyPolicy();
  const fallbackResult: DecisionResult = {
    verdict: policy === "approve" ? "APPROVE" : "REJECT",
    thesis: policy === "approve"
      ? "[Fallback automático — LLM indisponible. Sigo con el motor por defecto.]"
      : "[Fallback automático — LLM indisponible. No opero sin pensar.]",
    latencyMs: 0,
    modelUsed: "fallback-emergency",
    fromFallback: true,
  };
  console.warn(TAG, `${ctx.type} ${ctx.symbol} → FALLBACK ${fallbackResult.verdict} (LLM no respondió)`);
  return fallbackResult;
}

// Wrapper que persiste el outcome de la ejecución después.
export async function recordExecution(
  ctx: DecisionContext, result: DecisionResult, executed: boolean, executionError: string | null = null
): Promise<void> {
  await persist(ctx, result, executed, executionError);
}

export async function listRecentDecisions(limit = 20): Promise<any[]> {
  try {
    const r = await pool.query(
      `SELECT id, decision_type, symbol, verdict, thesis, executed, latency_ms, model_used, created_at
       FROM tanit_decisions ORDER BY id DESC LIMIT $1`,
      [Math.max(1, Math.min(100, limit))]
    );
    return r.rows;
  } catch (e: any) {
    console.error(TAG, `listRecentDecisions error: ${e?.message ?? e}`);
    return [];
  }
}
