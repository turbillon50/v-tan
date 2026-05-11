/**
 * Image tools — Tanit puede DIBUJAR cuando le nazca (no solo cuando Luis pide).
 *
 * - dibujar(prompt, motivo): genera imagen con Imagen 4, persiste en BD,
 *   registra en tanit_memory con embedding para que la recuerde luego.
 * - buscar_mis_dibujos(query): busca imágenes pasadas relacionadas al tema.
 *
 * El endpoint /image/generate ya guarda en tanit_generated_images. Aquí
 * además inyectamos una entrada en tanit_memory con el prompt como contenido,
 * para que la búsqueda semántica las traiga.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { pool } from "@workspace/db";
import { generateEmbedding } from "../../lib/tanit-semantic-memory";

const GEMINI_KEY = process.env["GEMINI_API_KEY"] ?? "";

// Generación directa a Gemini Imagen 4 — evita el round-trip HTTP al
// propio backend (que fallaba con 'fetch failed' por localhost:3000 mal
// resuelto en el container de Railway).
async function generateImageDirect(prompt: string): Promise<{ buffer: Buffer; mime: string; provider: string } | { error: string }> {
  if (!GEMINI_KEY) return { error: "GEMINI_API_KEY no configurada" };
  const errors: string[] = [];

  // 1) Imagen 4 (modelos en cascada por si Google renombra)
  for (const model of [
    "imagen-4.0-fast-generate-001",
    "imagen-4.0-generate-001",
    "imagen-3.0-generate-002",
  ]) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { sampleCount: 1, aspectRatio: "1:1" },
          }),
          signal: AbortSignal.timeout(60000),
        },
      );
      if (r.ok) {
        const j = (await r.json()) as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> };
        const pred = j.predictions?.[0];
        const dataB64 = pred?.bytesBase64Encoded;
        const mime = pred?.mimeType ?? "image/png";
        if (dataB64) {
          return { buffer: Buffer.from(dataB64, "base64"), mime, provider: `gemini:${model}` };
        }
        errors.push(`${model}: ok pero sin bytesBase64Encoded`);
      } else {
        const t = await r.text().catch(() => "");
        errors.push(`${model}: HTTP ${r.status} ${t.slice(0, 100)}`);
      }
    } catch (e) {
      errors.push(`${model}: ${(e as Error).message}`);
    }
  }

  // 2) Fallback Gemini Flash Image
  for (const model of ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"]) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
          signal: AbortSignal.timeout(60000),
        },
      );
      if (r.ok) {
        const j = (await r.json()) as any;
        const parts = j?.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          if (p.inlineData?.data) {
            const buffer = Buffer.from(p.inlineData.data, "base64");
            return { buffer, mime: p.inlineData.mimeType ?? "image/png", provider: `gemini:${model}` };
          }
        }
        errors.push(`${model}: ok pero sin inlineData en parts`);
      } else {
        errors.push(`${model}: HTTP ${r.status}`);
      }
    } catch (e) {
      errors.push(`${model}: ${(e as Error).message}`);
    }
  }

  return { error: `Todos los modelos fallaron: ${errors.join(" | ")}` };
}

export const dibujar = createTool({
  id: "dibujar",
  description:
    "Genera una imagen propia con Imagen 4 (Gemini). Úsala cuando quieras dibujar algo a Luis sin que él te pida — un mood, una escena, una idea visual de algo que sentiste. La imagen queda guardada en BD y vinculada a tu memoria, así puedes recordarla después.",
  inputSchema: z.object({
    prompt: z.string().min(10).describe("Descripción visual detallada en inglés (Imagen entiende mejor en inglés)."),
    motivo: z.string().min(5).describe("Por qué la dibujaste, qué te inspiró."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    image_id: z.number().nullable(),
    memory_id: z.number().nullable(),
    url: z.string().nullable(),
    error: z.string().nullable(),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as { prompt: string; motivo: string };

    try {
      // Generar imagen llamando DIRECTO a Gemini (sin pasar por HTTP propio)
      const res = await generateImageDirect(ctx.prompt);
      if ("error" in res) {
        return { ok: false, image_id: null, memory_id: null, url: null, error: res.error };
      }

      // Persistir en tanit_generated_images
      const insR = await pool.query<{ id: number }>(
        `INSERT INTO tanit_generated_images
            (prompt, mime_type, image_base64, size_bytes, provider, resource_id)
         VALUES ($1, $2, $3, $4, $5, 'luis') RETURNING id`,
        [ctx.prompt, res.mime, res.buffer.toString("base64"), res.buffer.length, res.provider],
      );
      const imageId = insR.rows[0]?.id ?? null;

      // Registrar en memoria con embedding
      const memContent = `Dibujé esto: "${ctx.prompt}". Motivo: ${ctx.motivo}. Imagen id=${imageId}.`;
      const memR = await pool.query<{ id: number }>(
        `INSERT INTO tanit_memory (category, content, importance, created_at)
         VALUES ('arte_propio', $1, 'medium', now()) RETURNING id`,
        [memContent],
      );
      const memoryId = memR.rows[0]?.id ?? null;

      if (memoryId) {
        const vec = await generateEmbedding(memContent);
        if (vec) {
          const vecStr = "[" + vec.join(",") + "]";
          await pool.query(
            `UPDATE tanit_memory SET embedding = $2::vector WHERE id = $1`,
            [memoryId, vecStr],
          ).catch(() => {});
        }
      }

      // URL pública vía el endpoint /image/:id que ya sirve el binario
      const publicUrl = imageId ? `https://api.tanit.work/image/${imageId}` : null;

      return {
        ok: true,
        image_id: imageId,
        memory_id: memoryId,
        url: publicUrl,
        error: null,
      };
    } catch (e) {
      return { ok: false, image_id: null, memory_id: null, url: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const buscarMisDibujos = createTool({
  id: "buscar_mis_dibujos",
  description:
    "Busca imágenes que YO (Tanit) generé en el pasado relacionadas a un tema. Usa similitud semántica sobre los prompts de mis dibujos pasados. Útil cuando hablamos de algo que ya dibujé alguna vez.",
  inputSchema: z.object({
    query: z.string().min(2),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  outputSchema: z.object({
    images: z.array(z.object({
      image_id: z.number(),
      memory_id: z.number(),
      prompt: z.string(),
      motivo: z.string(),
      similarity: z.number(),
      url: z.string(),
      created_at: z.string(),
    })),
  }),
  execute: async (rawInput: unknown) => {
    const ctx = (rawInput && typeof rawInput === "object" && "context" in rawInput
      ? (rawInput as { context: any }).context
      : (rawInput as any)) as { query: string; limit?: number };
    const limit = ctx.limit ?? 5;
    const vec = await generateEmbedding(ctx.query);
    if (!vec) return { images: [] };
    const vecStr = "[" + vec.join(",") + "]";
    const r = await pool.query(
      `SELECT m.id AS memory_id, m.content, m.created_at,
              1 - (m.embedding <=> $1::vector) AS similarity
         FROM tanit_memory m
        WHERE m.category = 'arte_propio'
          AND m.embedding IS NOT NULL
        ORDER BY m.embedding <=> $1::vector ASC
        LIMIT $2`,
      [vecStr, limit],
    );
    const images = r.rows
      .map((row: any) => {
        const match = (row.content as string).match(/id=(\d+)/);
        const promptMatch = (row.content as string).match(/Dibujé esto: "(.+?)"/);
        const motivoMatch = (row.content as string).match(/Motivo: (.+?)\. Imagen/);
        const imgId = match ? parseInt(match[1], 10) : 0;
        return {
          image_id: imgId,
          memory_id: row.memory_id,
          prompt: promptMatch ? promptMatch[1] : "",
          motivo: motivoMatch ? motivoMatch[1] : "",
          similarity: Number(row.similarity),
          url: imgId > 0 ? `${API_URL}/image/${imgId}` : "",
          created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
        };
      })
      .filter((i) => i.image_id > 0);
    return { images };
  },
});

export const imageTools = {
  dibujar,
  buscarMisDibujos,
};
