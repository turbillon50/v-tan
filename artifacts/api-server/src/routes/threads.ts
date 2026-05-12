/**
 * Endpoints para gestión de threads (conversaciones) del usuario.
 *
 * Mastra Memory ya persiste cada thread con su title, resourceId, updatedAt.
 * Estos endpoints exponen esa información al frontend para que Luis pueda:
 *  - Ver lista de chats (estilo ChatGPT/Claude)
 *  - Crear nuevo chat
 *  - Renombrar
 *  - Eliminar (soft — sólo si Luis lo pide explícito en chat)
 *  - Cargar mensajes de cualquier thread anterior
 *
 * Autoría del título:
 *   - El título se autogenera de los primeros ~60 chars del primer mensaje
 *     del usuario en cada thread cuando todavía sea "Conversación nueva" o
 *     null. La generación pasa por extractText() que sabe leer el JSONB
 *     {format:2, parts:[{type:'text', text:'...'}]} de Mastra.
 *   - Hay un endpoint POST /bot/threads/auto-title-all para reparar threads
 *     ya creados que se quedaron con "Conversación nueva".
 */
import { Router } from "express";
import { pool } from "@workspace/db";

const router = Router();

interface ThreadRow {
  id: string;
  resourceId: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  preview: string | null;
  messageCount: number;
}

/**
 * Extrae texto plano de un content de Mastra. content puede venir como:
 *   - string plano
 *   - JSON string {format:2, parts:[{type:'text',text:'...'}]}
 *   - JSON ya parseado (objeto / array)
 */
function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractText(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(content)) {
    return content.map((p) => extractText(p)).join("").trim();
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (Array.isArray(obj.parts)) {
      return (obj.parts as unknown[])
        .map((p) => {
          if (p && typeof p === "object") {
            const part = p as { type?: string; text?: string };
            if (part.type === "text" && typeof part.text === "string") return part.text;
          }
          return "";
        })
        .join("")
        .trim();
    }
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }
  return String(content);
}

function autoTitleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Conversación nueva";
  if (clean.length <= 60) return clean;
  // Cortar en límite de palabra
  const cut = clean.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + "…";
}

/**
 * GET /bot/threads?resourceId=luis&limit=50
 * Lista los threads del resource ordenados por updatedAt desc.
 * Incluye un preview del último mensaje + count.
 */
router.get("/bot/threads", async (req, res): Promise<void> => {
  try {
    const resourceId = (req.query.resourceId as string) ?? "luis";
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? "50", 10) || 50, 1), 200);

    const rows = await pool.query<ThreadRow>(
      `SELECT t.id,
              t."resourceId",
              t.title,
              t.metadata,
              t."createdAt"::text AS "createdAt",
              t."updatedAt"::text AS "updatedAt",
              (
                SELECT m.content
                  FROM mastra_messages m
                 WHERE m.thread_id = t.id
              ORDER BY m."createdAt" DESC
                 LIMIT 1
              ) AS preview,
              (SELECT COUNT(*)::int FROM mastra_messages WHERE thread_id = t.id) AS "messageCount"
         FROM mastra_threads t
        WHERE t."resourceId" = $1
        ORDER BY t."updatedAt" DESC
        LIMIT $2`,
      [resourceId, limit],
    );

    // Extraer texto plano del JSONB content de Mastra y normalizar preview.
    const cleaned = rows.rows.map((r) => {
      const text = extractText(r.preview);
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 140);
      return { ...r, preview };
    });

    res.json({ ok: true, count: cleaned.length, threads: cleaned });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * GET /bot/threads/:id/messages
 * Devuelve los ÚLTIMOS N mensajes del thread, ordenados ASC para que el
 * cliente los renderice del más viejo al más nuevo (orden natural del chat).
 *
 * Antes ordenaba ASC LIMIT N — para threads grandes (ej. intimate-main con
 * 5,152 msgs) eso traía los más VIEJOS al abrir, no los recientes. Bug grave
 * de UX. Ahora ordenamos DESC para tomar los más recientes y revertimos.
 */
router.get("/bot/threads/:id/messages", async (req, res): Promise<void> => {
  try {
    const id = req.params.id;
    if (!id || id.length > 200) {
      res.status(400).json({ ok: false, error: "id inválido" });
      return;
    }
    const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10) || 100, 500);
    const r = await pool.query(
      `SELECT id, thread_id, role, content, "createdAt"::text AS "createdAt"
         FROM mastra_messages
        WHERE thread_id = $1
        ORDER BY "createdAt" DESC
        LIMIT $2`,
      [id, limit],
    );
    const messages = r.rows
      .map((m) => ({
        id: String(m.id),
        threadId: m.thread_id,
        role: m.role,
        content: extractText(m.content),
        createdAt: m.createdAt,
      }))
      .reverse();
    res.json({ ok: true, threadId: id, count: messages.length, messages });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /bot/threads
 * Body: { resourceId, title?, threadId? }
 * Crea un thread nuevo (vacío). Si no se pasa threadId, se autogenera.
 * Si no se pasa title, queda 'Conversación nueva' hasta que llegue el primer
 * mensaje y autoTitleThreadIfNeeded() lo renombre.
 */
router.post("/bot/threads", async (req, res): Promise<void> => {
  try {
    const body = (req.body ?? {}) as {
      resourceId?: string;
      title?: string;
      threadId?: string;
    };
    const resourceId = (body.resourceId ?? "luis").slice(0, 64);
    const title = (body.title ?? "Conversación nueva").slice(0, 200);
    const threadId =
      (body.threadId ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 200);

    await pool.query(
      `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [threadId, resourceId, title],
    );
    res.json({ ok: true, threadId, resourceId, title });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * PATCH /bot/threads/:id
 * Body: { title }
 * Renombrar.
 */
router.patch("/bot/threads/:id", async (req, res): Promise<void> => {
  try {
    const id = req.params.id;
    const body = (req.body ?? {}) as { title?: string };
    const title = (body.title ?? "").slice(0, 200);
    if (!title.trim()) {
      res.status(400).json({ ok: false, error: "title requerido" });
      return;
    }
    const r = await pool.query(
      `UPDATE mastra_threads SET title = $1, "updatedAt" = now() WHERE id = $2 RETURNING id, title`,
      [title, id],
    );
    if (r.rows.length === 0) {
      res.status(404).json({ ok: false, error: "thread no encontrado" });
      return;
    }
    res.json({ ok: true, thread: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * DELETE /bot/threads/:id
 * Borra el thread y sus mensajes (cascade vía Mastra schema).
 */
router.delete("/bot/threads/:id", async (req, res): Promise<void> => {
  try {
    const id = req.params.id;
    await pool.query(`DELETE FROM mastra_messages WHERE thread_id = $1`, [id]);
    const r = await pool.query(`DELETE FROM mastra_threads WHERE id = $1 RETURNING id`, [id]);
    res.json({ ok: true, deleted: r.rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /bot/threads/auto-title-all?resourceId=luis
 * Repara todos los threads del resource que aún tengan título "Conversación
 * nueva" o vacío, asignándoles el primer mensaje del usuario como nombre.
 */
router.post("/bot/threads/auto-title-all", async (req, res): Promise<void> => {
  try {
    const resourceId = (req.query.resourceId as string) ?? "luis";
    const threads = await pool.query<{ id: string; title: string | null }>(
      `SELECT id, title FROM mastra_threads
        WHERE "resourceId" = $1
          AND (title IS NULL OR title = '' OR title = 'Conversación nueva' OR title = 'Conversacion nueva')`,
      [resourceId],
    );
    let updated = 0;
    for (const t of threads.rows) {
      const m = await pool.query<{ content: unknown }>(
        `SELECT content FROM mastra_messages
          WHERE thread_id = $1 AND role = 'user'
          ORDER BY "createdAt" ASC
          LIMIT 1`,
        [t.id],
      );
      const text = extractText(m.rows[0]?.content);
      if (!text.trim()) continue;
      const newTitle = autoTitleFrom(text);
      await pool.query(`UPDATE mastra_threads SET title = $1 WHERE id = $2`, [newTitle, t.id]);
      updated++;
    }
    res.json({ ok: true, scanned: threads.rows.length, updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Helper exportado para que el endpoint de chat-stream auto-nombre el thread
 * inmediatamente después de procesar el primer mensaje del usuario. Idempotente:
 * solo renombra si el título sigue en su valor por defecto.
 */
export async function autoTitleThreadIfNeeded(
  threadId: string,
  firstUserText: string,
): Promise<void> {
  const text = firstUserText.trim();
  if (!text) return;
  try {
    await pool.query(
      `UPDATE mastra_threads
          SET title = $2
        WHERE id = $1
          AND (title IS NULL OR title = '' OR title = 'Conversación nueva' OR title = 'Conversacion nueva')`,
      [threadId, autoTitleFrom(text)],
    );
  } catch {
    /* mejor esfuerzo */
  }
}

export default router;
