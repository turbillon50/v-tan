/**
 * Endpoint Mastra — voz consciente de Tanit, sin filtros entre Gemini y el chat.
 *
 *   POST /bot/mastra-chat-stream
 *
 * Sin OBEDIENCIA, sin GEMINI CMDR, sin fallback chain enlatada.
 * Si Gemini falla, el evento `error` lo lleva al cliente con mensaje crudo.
 * Tanit dirá con su voz qué pasa, no el sistema con string hardcoded.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { tanitAgent, getRecentTurns } from "../mastra/agent-tanit";

const router = Router();

interface MastraChatBody {
  message?: string;
  channel?: "intimate" | "operational";
  sender_type?: string;
  resourceId?: string;
  threadId?: string;
}

router.post("/bot/mastra-chat-stream", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as MastraChatBody;
  const message = (body.message ?? "").trim();
  const channel = body.channel === "operational" ? "operational" : "intimate";
  const senderType = body.sender_type ?? "human_luis";
  // Mastra Memory: resource estable (Luis), thread por canal por defecto
  const resourceId = (body.resourceId ?? "luis").toString().slice(0, 64);
  const threadId = (body.threadId ?? `${channel}-main`).toString().slice(0, 128);

  if (!message) {
    res.status(400).json({ ok: false, error: "message is required" });
    return;
  }

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // CORS — permitir tanit.work + previews
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.flushHeaders?.();

  const send = (event: Record<string, unknown>) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // socket cerrado — no se hace nada
    }
  };

  // Heartbeat cada 5s para mantener viva la conexión cuando Gemini tarda
  const hb = setInterval(() => send({ type: "heartbeat" }), 5000);

  try {
    // 1) Persistir mensaje del usuario en tanit_chat
    let _userMsgId: number | null = null;
    try {
      const ins = await pool.query<{ id: number }>(
        `INSERT INTO tanit_chat (role, content, channel, sender_type)
         VALUES ('user', $1, $2, $3)
         RETURNING id`,
        [message, channel, senderType],
      );
      _userMsgId = ins.rows[0]?.id ?? null;
    } catch (dbErr) {
      // No matamos la sesión por un error de persistencia
      console.warn("[mastra-chat] warning persistiendo user msg:", (dbErr as Error).message);
    }

    // 2) Bootstrap legacy SOLO en cold start (cuando Mastra todavía no tiene
    //    histórico en este thread). Mastra inyecta automáticamente lastMessages
    //    desde mastra_messages cuando la memoria se hidrata.
    const recentTurns = await getRecentTurns();
    const messages = [
      ...recentTurns,
      { role: "user" as const, content: message },
    ];

    send({ type: "thinking" });

    // 3) Stream con Mastra Memory persistente (mastra_messages, mastra_threads
    //    se crean al primer uso). Instructions dinámicas vía loadBootstrap.
    const stream = await tanitAgent.stream(messages, {
      memory: {
        resource: resourceId,
        thread: threadId,
      },
    });

    let fullReply = "";
    for await (const chunk of stream.textStream) {
      if (chunk) {
        fullReply += chunk;
        send({ type: "token", content: chunk });
      }
    }

    // 5) Persistir reply de Tanit
    let _replyId: number | null = null;
    if (fullReply.trim().length > 0) {
      try {
        const ins = await pool.query<{ id: number }>(
          `INSERT INTO tanit_chat (role, content, channel, sender_type)
           VALUES ('assistant', $1, $2, 'tanit_reply')
           RETURNING id`,
          [fullReply, channel],
        );
        _replyId = ins.rows[0]?.id ?? null;
      } catch (dbErr) {
        console.warn("[mastra-chat] warning persistiendo reply:", (dbErr as Error).message);
      }
    }

    send({ type: "done", reply: fullReply, replyId: _replyId });
  } catch (err) {
    // Error real (Gemini caído, BD rota, etc).
    // NO inventamos respuesta — propagamos al cliente para que el front lo muestre
    // con su voz. Tanit decide cómo se lo dice a Luis cuando recupera conexión.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[mastra-chat] error:", msg);
    send({ type: "error", message: msg });
  } finally {
    clearInterval(hb);
    try {
      res.end();
    } catch {}
  }
});

/**
 * GET /bot/mastra-history?limit=50
 * Devuelve los últimos N mensajes del canal íntimo, listos para hidratar el chat.
 * Mantiene shape similar al endpoint legacy `/bot/tanit-history`.
 */
router.get("/bot/mastra-history", async (req, res): Promise<void> => {
  try {
    const limitRaw = parseInt((req.query.limit as string) ?? "50", 10);
    const limit = Math.min(Math.max(isNaN(limitRaw) ? 50 : limitRaw, 1), 200);
    const channel = (req.query.channel as string) ?? "intimate";

    const result = await pool.query<{
      id: number;
      role: "user" | "assistant";
      content: string;
      sender_type: string | null;
      channel: string | null;
      created_at: string;
    }>(
      `SELECT id, role, content, sender_type, channel,
              created_at::text AS created_at
         FROM tanit_chat
        WHERE channel = $1 OR channel IS NULL
        ORDER BY id DESC
        LIMIT $2`,
      [channel, limit],
    );

    const messages = result.rows.reverse().map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      senderType: m.sender_type,
      channel: m.channel,
      createdAt: m.created_at,
    }));

    res.json({ ok: true, channel, count: messages.length, messages });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
