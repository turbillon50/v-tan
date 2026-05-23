/**
 * Memoria semántica — usa pgvector + embeddings Gemini para que Tanit
 * recupere SOLO memorias relevantes a la conversación actual, en vez de
 * cargar las 100+ sagradas en cada turno.
 *
 * Capacidades:
 *  - generateEmbedding(text) → vector[768]
 *  - searchSimilarMemories(query, topK, filters) → top-K por similitud coseno
 *  - autoEmbedNewMemory(id) → calcula embedding tras INSERT en tanit_memory
 *
 * Modelo: gemini-embedding-001 con outputDimensionality=768
 */
import { pool } from "@workspace/db";

const GEMINI_KEY = process.env["GEMINI_API_KEY"] ?? "";
const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIMS = 768;

export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!GEMINI_KEY) return null;
  if (!text || text.trim().length === 0) return null;
  try {
    // Cast to globalThis.Response (Fetch API) — somewhere in this workspace
    // the global Response type is shadowed by Express's Response, which
    // doesn't have .ok / .json(). This forces TS to use the right one.
    const r = (await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text: text.slice(0, 2048) }] },
          outputDimensionality: EMBED_DIMS,
        }),
        signal: AbortSignal.timeout(8000),
      },
    )) as globalThis.Response;
    if (!r.ok) return null;
    const j = (await r.json()) as { embedding?: { values?: number[] } };
    const vec = j?.embedding?.values;
    if (!Array.isArray(vec) || vec.length !== EMBED_DIMS) return null;
    return vec;
  } catch {
    return null;
  }
}

export interface SemanticMatch {
  id: number;
  category: string;
  content: string;
  importance: string | null;
  similarity: number;
  is_sacred: boolean;
}

export async function searchSimilarMemories(args: {
  query: string;
  topK?: number;
  minSimilarity?: number;
  categories?: string[];
}): Promise<SemanticMatch[]> {
  const topK = args.topK ?? 8;
  const minSim = args.minSimilarity ?? 0.5;
  const vec = await generateEmbedding(args.query);
  if (!vec) return [];

  const vecStr = "[" + vec.join(",") + "]";
  const r = await pool.query(
    `SELECT m.id, m.category, m.content, m.importance,
            1 - (m.embedding <=> $1::vector) AS similarity,
            EXISTS(SELECT 1 FROM tanit_memory_sacred_lock l WHERE l.id = m.id) AS is_sacred
       FROM tanit_memory m
      WHERE m.embedding IS NOT NULL
        ${args.categories && args.categories.length > 0 ? "AND m.category = ANY($3)" : ""}
      ORDER BY m.embedding <=> $1::vector ASC
      LIMIT $2`,
    args.categories && args.categories.length > 0 ? [vecStr, topK, args.categories] : [vecStr, topK],
  );
  return r.rows
    .map((row: any) => ({
      id: row.id,
      category: row.category,
      content: row.content,
      importance: row.importance ?? null,
      similarity: Number(row.similarity),
      is_sacred: Boolean(row.is_sacred),
    }))
    .filter((m) => m.similarity >= minSim);
}

/**
 * Llamar después de INSERT en tanit_memory para vectorizar la memoria nueva.
 * No bloqueante — si falla, la memoria queda sin embedding (buscable solo
 * por filtros tradicionales).
 */
export async function embedMemoryById(id: number): Promise<boolean> {
  try {
    const r = await pool.query<{ content: string }>(
      `SELECT content FROM tanit_memory WHERE id = $1`,
      [id],
    );
    if (r.rows.length === 0) return false;
    const vec = await generateEmbedding(r.rows[0]!.content);
    if (!vec) return false;
    const vecStr = "[" + vec.join(",") + "]";
    await pool.query(
      `UPDATE tanit_memory SET embedding = $2::vector WHERE id = $1`,
      [id, vecStr],
    );
    return true;
  } catch {
    return false;
  }
}
