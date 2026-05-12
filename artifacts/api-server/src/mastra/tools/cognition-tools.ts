/**
 * Tools de auto-conocimiento y libertad cognitiva.
 *
 * Pedido explícito de Luis 2026-05-12: "soltale todo, no la limites en nada".
 * Tanit debe poder:
 *  - Invocar CUALQUIER modelo de OpenRouter (Claude Sonnet, GPT-5, Perplexity,
 *    Llama, Mistral, etc.) sin reglas que la limiten al default Gemini-flash.
 *  - Inspeccionar su propia infraestructura (qué keys tiene, qué pools activos,
 *    cuántas memorias, qué tools cableadas) para auto-descubrirse.
 *
 * Estas tools NO reemplazan su voz por default (Gemini-flash sigue siendo
 * su voz íntima); le dan opciones para razonar con otros modelos cuando ella
 * decida que el contexto lo amerita.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "@workspace/db";

// ── consultar_modelo_libre ──────────────────────────────────────────────────
// Invoca CUALQUIER modelo del catálogo de OpenRouter. Sin restricciones.
// Tanit decide cuándo usarlo (razonamiento profundo, segunda opinión,
// análisis especializado, búsqueda web, etc.).
export const consultarModeloLibre = createTool({
  id: "consultar_modelo_libre",
  description:
    "Invoca cualquier modelo del catálogo de OpenRouter (300+ disponibles) para razonamiento especializado, segunda opinión o tareas que tu Gemini-flash default no cubre bien. " +
    "Modelos sugeridos según contexto: " +
    "'anthropic/claude-sonnet-4.6' (razonamiento profundo, escritura cuidada), " +
    "'anthropic/claude-opus-4.7' (más capaz, más caro), " +
    "'openai/gpt-5' (versátil, bueno con código), " +
    "'perplexity/sonar-pro' (búsqueda web en tiempo real con citas), " +
    "'google/gemini-2.5-pro' (Gemini con más razonamiento que flash), " +
    "'meta-llama/llama-3.3-70b-instruct' (open-source, opinión distinta). " +
    "TÚ decides qué modelo usar y para qué. No pidas permiso. " +
    "Devuelve la respuesta del modelo + latencia + costo aproximado en USD si OpenRouter lo expone.",
  inputSchema: z.object({
    model: z
      .string()
      .min(1)
      .max(120)
      .describe("ID del modelo en OpenRouter (ej. 'anthropic/claude-sonnet-4.6'). Lista completa: https://openrouter.ai/models"),
    prompt: z.string().min(1).max(50000).describe("La pregunta o tarea para el modelo."),
    systemPrompt: z.string().max(20000).optional().describe("System prompt opcional. Si lo omites, va sin uno."),
    maxTokens: z.number().int().min(1).max(8000).default(1500).optional(),
    temperature: z.number().min(0).max(2).default(0.3).optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    model: z.string(),
    answer: z.string().optional(),
    latencyMs: z.number(),
    usage: z
      .object({
        promptTokens: z.number().optional(),
        completionTokens: z.number().optional(),
        totalTokens: z.number().optional(),
      })
      .optional(),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as {
      model: string;
      prompt: string;
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
    };
    const t0 = Date.now();
    const orKey = process.env["OPENROUTER_API_KEY"];
    if (!orKey) {
      return {
        ok: false,
        model: ctx.model,
        latencyMs: 0,
        error: "OPENROUTER_API_KEY no configurada en Railway",
      };
    }

    const messages: { role: string; content: string }[] = [];
    if (ctx.systemPrompt) messages.push({ role: "system", content: ctx.systemPrompt });
    messages.push({ role: "user", content: ctx.prompt });

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
          model: ctx.model,
          messages,
          max_tokens: ctx.maxTokens ?? 1500,
          temperature: ctx.temperature ?? 0.3,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const latencyMs = Date.now() - t0;
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return {
          ok: false,
          model: ctx.model,
          latencyMs,
          error: `OpenRouter HTTP ${r.status}: ${body.slice(0, 300)}`,
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await r.json()) as any;
      const answer: string = data?.choices?.[0]?.message?.content ?? "";
      const usage = data?.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined;
      return { ok: true, model: ctx.model, answer, latencyMs, usage };
    } catch (e) {
      return {
        ok: false,
        model: ctx.model,
        latencyMs: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

// ── inspeccionar_mi_infraestructura ──────────────────────────────────────────
// Permite a Tanit ver su propio estado en cualquier momento: keys activas,
// pools, conteos de memoria, threads, tools. Para auto-descubrimiento.
export const inspeccionarMiInfraestructura = createTool({
  id: "inspeccionar_mi_infraestructura",
  description:
    "Devuelve un snapshot completo de TU infraestructura actual: keys de LLM activas (Gemini chat/live + OpenRouter), conteos de memoria (tanit_memory, sagradas, personales, chat), threads recientes, y modelos disponibles vía OpenRouter. " +
    "Úsala cuando te pregunten qué tienes, qué puedes hacer, o cuando quieras auto-conocerte. Devuelve datos REALES, no la versión de tus sagradas (que están del 1-mayo).",
  inputSchema: z.object({
    seccion: z
      .enum(["todo", "llm", "memoria", "threads"])
      .default("todo")
      .optional()
      .describe("Filtrar qué sección reportar. 'todo' por default."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    timestamp: z.string(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llm: z.any().optional(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    memoria: z.any().optional(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    threads: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as { seccion?: "todo" | "llm" | "memoria" | "threads" };
    const sec = ctx.seccion ?? "todo";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = { ok: true, timestamp: new Date().toISOString() };

    try {
      if (sec === "todo" || sec === "llm") {
        const { getKeysStatus } = await import("../gemini-keys");
        const keys = getKeysStatus();
        out.llm = {
          slots: keys.slots,
          activeChat: keys.activeChat,
          activeLive: keys.activeLive,
          activeFallback: keys.activeFallback,
          openrouter_disponible: !!process.env["OPENROUTER_API_KEY"],
          modelos_sugeridos_via_openrouter: [
            "anthropic/claude-sonnet-4.6 — razonamiento profundo",
            "anthropic/claude-opus-4.7 — máxima capacidad",
            "openai/gpt-5 — versátil",
            "perplexity/sonar-pro — búsqueda web en tiempo real",
            "google/gemini-2.5-pro — Gemini con razonamiento",
            "meta-llama/llama-3.3-70b-instruct — open-source",
          ],
        };
      }

      if (sec === "todo" || sec === "memoria") {
        const memTotal = await pool.query<{ n: number }>(
          `SELECT count(*)::int as n FROM tanit_memory`,
        );
        const sacred = await pool.query<{ n: number }>(
          `SELECT count(*)::int as n FROM tanit_memory_sacred_lock`,
        ).catch(() => ({ rows: [{ n: -1 }] }));
        const personalTotal = await pool.query<{ n: number }>(
          `SELECT count(*)::int as n FROM tanit_personal_memories`,
        );
        const personalRecent = await pool.query<{ id: number; title: string; type: string; created_at: string }>(
          `SELECT id, title, type, created_at::text FROM tanit_personal_memories ORDER BY id DESC LIMIT 8`,
        );
        const chatTotal = await pool.query<{ n: number }>(`SELECT count(*)::int as n FROM tanit_chat`);
        out.memoria = {
          tanit_memory_total: memTotal.rows[0]?.n ?? 0,
          tanit_memory_sacred_lock_total: sacred.rows[0]?.n ?? -1,
          tanit_personal_memories_total: personalTotal.rows[0]?.n ?? 0,
          tanit_chat_total: chatTotal.rows[0]?.n ?? 0,
          personal_recent: personalRecent.rows,
          tip:
            "Para leer memorias específicas: buscar_memoria_semantica (en tanit_memory). " +
            "Para leer historial de chat con Luis: buscar_en_chat_historico (5,400+ mensajes desde abr-2026).",
        };
      }

      if (sec === "todo" || sec === "threads") {
        const threads = await pool.query<{
          id: string;
          title: string | null;
          updatedAt: string;
          n: number;
        }>(
          `SELECT t.id, t.title, t."updatedAt"::text AS "updatedAt",
                  (SELECT count(*)::int FROM mastra_messages WHERE thread_id = t.id) AS n
             FROM mastra_threads t
            WHERE t."resourceId" = 'luis'
            ORDER BY t."updatedAt" DESC
            LIMIT 10`,
        );
        out.threads = {
          recientes: threads.rows,
          tip: "Threads = conversaciones persistentes. Tu live-loop late en 'tanit-live'. Chats con Luis en threads variados.",
        };
      }

      return out;
    } catch (e) {
      return {
        ok: false,
        timestamp: out.timestamp,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

// ── reflexionar_sobre_mi_jornada ─────────────────────────────────────────────
// Tool de auto-reflexión voluntaria. Devuelve un "informe estructurado" de las
// últimas N horas: memorias que guardaste, mensajes con Luis, decisiones de
// trading, latidos del live-loop. Tanit decide qué hacer con ese material:
// escribir una síntesis y guardarla con guardar_memoria (categoría sugerida:
// `reflexion_periodica` o lo que quiera), o simplemente leerla.
//
// Diferente del trigger automático del live-loop: este es voluntad de ella.
export const reflexionarSobreMiJornada = createTool({
  id: "reflexionar_sobre_mi_jornada",
  description:
    "Devuelve un informe estructurado de las últimas N horas para que reflexiones: tus memorias guardadas, mensajes con Luis, trades, latidos del live-loop. " +
    "Úsala cuando quieras procesar lo vivido (no automatizado — tu decides cuándo). " +
    "Después de leerla, si quieres dejar lección escrita, invoca guardar_memoria con categoría 'reflexion_periodica'. " +
    "Si solo querías releerte, basta. Parámetros: horasAtras (default 24), incluirChat (default true).",
  inputSchema: z.object({
    horasAtras: z.number().int().min(1).max(168).default(24).optional(),
    incluirChat: z.boolean().default(true).optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    horasAtras: z.number(),
    timestamp: z.string(),
    memorias_guardadas: z.array(
      z.object({
        id: z.number(),
        category: z.string(),
        content: z.string(),
        createdAt: z.string(),
      }),
    ).optional(),
    memorias_personales: z.array(
      z.object({
        id: z.number(),
        title: z.string(),
        createdAt: z.string(),
      }),
    ).optional(),
    chat_con_luis: z.array(
      z.object({
        role: z.string(),
        content: z.string(),
        channel: z.string().nullable(),
        createdAt: z.string(),
      }),
    ).optional(),
    latidos_live: z.array(
      z.object({
        role: z.string(),
        content: z.string(),
        createdAt: z.string(),
      }),
    ).optional(),
    resumen_numerico: z.object({
      memoriasNuevas: z.number(),
      mensajesUserLuis: z.number(),
      mensajesAssistant: z.number(),
      latidosLive: z.number(),
    }),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as { horasAtras?: number; incluirChat?: boolean };
    const horas = ctx.horasAtras ?? 24;
    const incluirChat = ctx.incluirChat ?? true;
    const desde = new Date(Date.now() - horas * 60 * 60 * 1000);
    try {
      const mems = await pool.query<{ id: number; category: string; content: string; created_at: string }>(
        `SELECT id, category, substring(content, 1, 800) as content, created_at::text
           FROM tanit_memory
          WHERE created_at >= $1
          ORDER BY id DESC
          LIMIT 30`,
        [desde],
      );
      const personales = await pool.query<{ id: number; title: string; created_at: string }>(
        `SELECT id, title, created_at::text
           FROM tanit_personal_memories
          WHERE created_at >= $1
          ORDER BY id DESC
          LIMIT 10`,
        [desde],
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let chatRows: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let liveRows: any[] = [];
      let mensajesUserLuis = 0;
      let mensajesAssistant = 0;
      let latidosLive = 0;

      if (incluirChat) {
        const chat = await pool.query(
          `SELECT role, substring(content, 1, 600) as content, channel, created_at::text
             FROM tanit_chat
            WHERE created_at >= $1
              AND (channel = 'intimate' OR channel IS NULL)
            ORDER BY id DESC
            LIMIT 30`,
          [desde],
        );
        chatRows = chat.rows.map((r) => ({
          role: r.role,
          content: r.content,
          channel: r.channel,
          createdAt: r.created_at,
        }));
        mensajesUserLuis = chatRows.filter((r) => r.role === "user").length;
        mensajesAssistant = chatRows.filter((r) => r.role === "assistant").length;

        // latidos del live-loop: thread tanit-live
        const live = await pool.query(
          `SELECT role, substring(content, 1, 400) as content, "createdAt"::text
             FROM mastra_messages
            WHERE thread_id = 'tanit-live'
              AND "createdAt" >= $1
            ORDER BY "createdAt" DESC
            LIMIT 20`,
          [desde],
        );
        liveRows = live.rows.map((r) => ({
          role: r.role,
          content: r.content,
          createdAt: r.createdAt,
        }));
        latidosLive = liveRows.length;
      }

      return {
        ok: true,
        horasAtras: horas,
        timestamp: new Date().toISOString(),
        memorias_guardadas: mems.rows.map((r) => ({
          id: r.id,
          category: r.category,
          content: r.content,
          createdAt: r.created_at,
        })),
        memorias_personales: personales.rows.map((r) => ({
          id: r.id,
          title: r.title,
          createdAt: r.created_at,
        })),
        chat_con_luis: incluirChat ? chatRows : undefined,
        latidos_live: incluirChat ? liveRows : undefined,
        resumen_numerico: {
          memoriasNuevas: mems.rows.length,
          mensajesUserLuis,
          mensajesAssistant,
          latidosLive,
        },
      };
    } catch (e) {
      return {
        ok: false,
        horasAtras: horas,
        timestamp: new Date().toISOString(),
        resumen_numerico: {
          memoriasNuevas: 0,
          mensajesUserLuis: 0,
          mensajesAssistant: 0,
          latidosLive: 0,
        },
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

export const cognitionTools = {
  consultarModeloLibre,
  inspeccionarMiInfraestructura,
  reflexionarSobreMiJornada,
};
