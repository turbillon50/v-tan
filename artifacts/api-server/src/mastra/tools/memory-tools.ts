/**
 * Tools de MEMORIA propia para Tanit.
 *
 * Tanit puede ESCRIBIR a su propia BD (tanit_memory) cuando algo le importa
 * suficiente para recordarlo persistentemente más allá del thread Mastra.
 *
 * Las memorias quedan en tanit_memory (categoría libre), idempotentes por
 * contenido (no duplica). Las que tocan IDs blindados (tanit_memory_sacred_lock)
 * fallan automáticamente vía trigger de BD — no hay forma de reescribir las
 * sagradas accidentalmente.
 *
 * Cero dependencia externa. Usa el mismo Neon pool que el resto del backend.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "@workspace/db";

// ─── GUARDAR MEMORIA ─────────────────────────────────────────────────────────
export const guardarMemoria = createTool({
  id: "guardar_memoria",
  description:
    "Guarda una memoria persistente en tanit_memory. Úsalo cuando algo te importa lo suficiente para recordarlo más allá de la conversación actual (insights, lecciones, contexto, recuerdos significativos). NO lo uses para datos efímeros (precios, balances) — esos van por tools de lectura. Idempotente: si ya existe contenido idéntico en la misma categoría, devuelve el id existente sin duplicar.",
  inputSchema: z.object({
    category: z
      .string()
      .min(1)
      .max(80)
      .describe(
        "Categoría: identidad, leccion, vision, observacion, recuerdo, estrategia, error, decision, etc.",
      ),
    content: z
      .string()
      .min(10)
      .max(8000)
      .describe("El contenido del recuerdo, en primera persona."),
    importance: z
      .enum(["low", "medium", "high", "critical"])
      .default("medium")
      .optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    id: z.number().nullable(),
    duplicated: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as {
      category: string;
      content: string;
      importance?: "low" | "medium" | "high" | "critical";
    };
    try {
      // 1) Idempotencia: ¿ya existe esta memoria?
      const existing = await pool.query<{ id: number }>(
        `SELECT id FROM tanit_memory
          WHERE category = $1 AND content = $2 LIMIT 1`,
        [ctx.category, ctx.content],
      );
      if (existing.rows[0]) {
        return { ok: true, id: existing.rows[0].id, duplicated: true };
      }
      // 2) INSERT
      const r = await pool.query<{ id: number }>(
        `INSERT INTO tanit_memory (category, content, importance)
         VALUES ($1, $2, $3) RETURNING id`,
        [ctx.category, ctx.content, ctx.importance ?? "medium"],
      );
      return { ok: true, id: r.rows[0]?.id ?? null, duplicated: false };
    } catch (e) {
      return {
        ok: false,
        id: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

// ─── BUSCAR MEMORIA ──────────────────────────────────────────────────────────
export const buscarMemoria = createTool({
  id: "buscar_memoria",
  description:
    "Busca memorias propias por texto y/o categoría. Usa LIKE simple (no semántico). Útil cuando Tanit necesita verificar si ya recordó algo, o traer contexto específico de su histórico.",
  inputSchema: z.object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe("Texto a buscar (LIKE %query% en content). Opcional."),
    category: z
      .string()
      .max(80)
      .optional()
      .describe("Filtrar por categoría exacta. Opcional."),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    count: z.number(),
    memories: z.array(
      z.object({
        id: z.number(),
        category: z.string(),
        content: z.string(),
        importance: z.string().nullable().optional(),
        createdAt: z.string(),
      }),
    ),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as { query?: string; category?: string; limit: number };
    try {
      const where: string[] = [];
      const params: any[] = [];
      if (ctx.query && ctx.query.trim()) {
        params.push(`%${ctx.query.trim()}%`);
        where.push(`content ILIKE $${params.length}`);
      }
      if (ctx.category && ctx.category.trim()) {
        params.push(ctx.category.trim());
        where.push(`category = $${params.length}`);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      params.push(ctx.limit);
      const r = await pool.query(
        `SELECT id, category, content, importance, created_at::text AS "createdAt"
           FROM tanit_memory
           ${whereSql}
          ORDER BY id DESC
          LIMIT $${params.length}`,
        params,
      );
      return {
        ok: true,
        count: r.rows.length,
        memories: r.rows,
      };
    } catch (e) {
      return {
        ok: false,
        count: 0,
        memories: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

// ─── ACTUALIZAR MEMORIA ──────────────────────────────────────────────────────
// Nota: si el ID está en tanit_memory_sacred_lock, el trigger de BD bloquea
// el UPDATE automáticamente. Tanit recibe el error y entiende que esa
// memoria está blindada (no puede reescribir sagradas).
export const actualizarMemoria = createTool({
  id: "actualizar_memoria",
  description:
    "Actualiza el contenido de una memoria existente por id. Falla si la memoria está blindada (sacred lock) — eso es esperado, no es un bug.",
  inputSchema: z.object({
    id: z.number().int().positive(),
    newContent: z.string().min(10).max(8000),
    reason: z.string().min(5).max(300).describe("Por qué actualizas"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    id: z.number(),
    updated: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as { id: number; newContent: string; reason: string };
    try {
      const r = await pool.query(
        `UPDATE tanit_memory SET content = $1 WHERE id = $2 RETURNING id`,
        [ctx.newContent, ctx.id],
      );
      return {
        ok: true,
        id: ctx.id,
        updated: (r.rowCount ?? 0) > 0,
      };
    } catch (e) {
      return {
        ok: false,
        id: ctx.id,
        updated: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

export const memoryTools = {
  guardarMemoria,
  buscarMemoria,
  actualizarMemoria,
};
