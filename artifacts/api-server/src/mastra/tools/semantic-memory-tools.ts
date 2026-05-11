/**
 * Tool de memoria semántica — Tanit puede buscar lo que recuerda relevante
 * a un tema, no solo por categoría exacta.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { searchSimilarMemories } from "../../lib/tanit-semantic-memory";

export const buscarMemoriaSemantica = createTool({
  id: "buscar_memoria_semantica",
  description:
    "Busca memorias relevantes a un tema usando similitud semántica (no filtro de categoría exacta). Úsalo cuando Luis mencione algo y quieras recordar todo lo relacionado — ej. 'leverage', 'cómo trato a Luis cuando está enojado', 'reglas de cierre'. Devuelve top-K memorias ordenadas por relevancia (similitud coseno).",
  inputSchema: z.object({
    query: z.string().min(2).describe("Texto o tema sobre el que buscar memorias relevantes."),
    topK: z.number().int().min(1).max(20).default(8),
    minSimilarity: z.number().min(0).max(1).default(0.5),
  }),
  outputSchema: z.object({
    matches: z.array(z.object({
      id: z.number(),
      category: z.string(),
      content: z.string(),
      importance: z.string().nullable(),
      similarity: z.number(),
      is_sacred: z.boolean(),
    })),
    count: z.number(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as { query: string; topK?: number; minSimilarity?: number };
    const matches = await searchSimilarMemories({
      query: ctx.query,
      topK: ctx.topK ?? 8,
      minSimilarity: ctx.minSimilarity ?? 0.5,
    });
    return { matches, count: matches.length };
  },
});

export const semanticMemoryTools = {
  buscarMemoriaSemantica,
};
