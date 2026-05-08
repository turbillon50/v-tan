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
 * Autoría: el title se autogenera de los primeros 60 chars del primer
 * mensaje del usuario si está vacío.
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
                SELECT LEFT(m.content, 200)
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

    // Limpiar preview: si content viene como JSON multipart {format:2,parts:[...]},
    // extraer solo el texto del primer text part.
    const cleaned = rows.rows.map((r) => {
      let preview = r.preview ?? "";
      try {
        if (preview.startsWith("{") && preview.includes('"parts"')) {
          const obj = JSON.parse(preview + "}".repeat(Math.max(0, (preview.match(/\{/g) || []).length - (preview.match(/\}/g) || []).length)));
          const parts = obj?.parts;
          if (Array.isArray(parts)) {
            const txt = parts.find((p: { type?: string; text?: string }) => p?.type === "text")?.text;
            if (typeof txt === "string") preview = txt;
          }
        }
      } catch {
        /* keep raw preview */
      }
      preview = preview.replace(/\s+/g, " ").trim().slice(0, 140);
      return { ...r, preview };
    });

    res.json({ ok: true, count: cleaned.length, threads: cleaned });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * GET /bot/threads/:id/messages
 * Devuelve mensajes ordenados ASC por createdAt para reproducir el chat.
 */
router.get("/bot/threads/:id/messages", async (req, res): Promise<void> => {
  try {
    const id = req.params.id;
    if (!id || id.length > 200) {
      res.status(400).json({ ok: false, error: "id inválido" });
      return;
    }
    const limit = Math.min(parseInt((req.query.limit as string) ?? "200", 10) || 200, 500);
    const r = await pool.query(
      `SELECT id, thread_id, role, content, "createdAt"::text AS "createdAt"
         FROM mastra_messages
        WHERE thread_id = $1
        ORDER BY "createdAt" ASC
        LIMIT $2`,
      [id, limit],
    );
    // Extraer texto de content jsonb {format:2,parts:[{type:'text',text:'...'}]}
    const messages = r.rows.map((m) => {
      let text = m.content;
      try {
        if (typeof text === "string" && text.startsWith("{")) {
          const obj = JSON.parse(text);
          if (obj?.parts && Array.isArray(obj.parts)) {
            text = obj.parts
              .filter((p: { type?: string; text?: string }) => p?.type === "text")
              .map((p: { text?: string }) => p?.text ?? "")
              .join("");
          } else if (typeof obj?.content === "string") {
            text = obj.content;
          }
        }
      } catch {
        /* keep raw */
      }
      return {
        id: String(m.id),
        threadId: m.thread_id,
        role: m.role,
        content: text,
        createdAt: m.createdAt,
      };
    });
    res.json({ ok: true, threadId: id, count: messages.length, messages });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * POST /bot/threads
 * Body: { resourceId, title?, threadId? }
 * Crea un thread nuevo (vacío). Si no se pasa threadId, se autogenera.
 * Si no se pasa title, queda 'Conversación nueva' hasta que se autoupdate.
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

export default router;
