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
import { autoTitleThreadIfNeeded } from "./threads";

const router = Router();

interface MastraChatBody {
  message?: string;
  channel?: "intimate" | "operational";
  sender_type?: string;
  resourceId?: string;
  threadId?: string;
  // Multimodal — si Luis manda fotos en el chat, las pasamos al agent como
  // image parts. Gemini 2.5 Flash las procesa nativo.
  images?: Array<{ base64: string; mimeType: string }>;
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

    // Si el cliente mandó imágenes, construimos el mensaje del usuario con
    // multipart content (text + image_url parts). Gemini multimodal nativo.
    type ContentPart =
      | { type: "text"; text: string }
      | { type: "image"; image: string; mimeType?: string };
    type LooseUserMsg = {
      role: "user";
      content: string | ContentPart[];
    };

    let userMsg: LooseUserMsg;
    if (Array.isArray(body.images) && body.images.length > 0) {
      const parts: ContentPart[] = [{ type: "text", text: message }];
      for (const img of body.images.slice(0, 4)) {
        if (img && typeof img.base64 === "string" && img.base64.length > 0) {
          parts.push({
            type: "image",
            image: `data:${img.mimeType || "image/jpeg"};base64,${img.base64}`,
            mimeType: img.mimeType,
          });
        }
      }
      userMsg = { role: "user", content: parts };
    } else {
      userMsg = { role: "user", content: message };
    }

    const messages = [
      ...recentTurns,
      // Casteamos a any aquí porque el shape multimodal varía entre versiones
      // de @ai-sdk; Mastra lo acepta vía wrapper interno.
      userMsg as unknown as { role: "user"; content: string },
    ];

    send({ type: "thinking" });

    // 3) Stream con Mastra Memory persistente (mastra_messages, mastra_threads
    //    se crean al primer uso). Instructions dinámicas vía loadBootstrap.
    //    Iteramos `fullStream` para emitir además de tokens los eventos
    //    `tool_call` / `tool_result` que el frontend renderiza como inline cards.
    const stream = await tanitAgent.stream(messages, {
      memory: {
        resource: resourceId,
        thread: threadId,
      },
    });

    // Auto-rename del thread con el primer mensaje del usuario. Idempotente:
    // sólo renombra si todavía es "Conversación nueva". Lo disparamos en
    // background para no bloquear el stream de respuesta.
    autoTitleThreadIfNeeded(threadId, message).catch((e) =>
      console.warn("[mastra-chat] autoTitle warning:", (e as Error).message),
    );

    let fullReply = "";
    // fullStream emite: text-delta, tool-call, tool-result, finish, etc.
    // Mantenemos el contrato existente (token/heartbeat/done/error) y agregamos
    // tool_call y tool_result. Frontend viejo ignora los nuevos sin romper.
    for await (const chunk of stream.fullStream as AsyncIterable<{
      type: string;
      payload?: Record<string, unknown>;
    }>) {
      if (!chunk || !chunk.type) continue;
      const t = chunk.type;
      const p = chunk.payload ?? {};

      if (t === "text-delta") {
        const text = (p as { text?: string; delta?: string }).text
          ?? (p as { delta?: string }).delta
          ?? "";
        if (text) {
          fullReply += text;
          send({ type: "token", content: text });
        }
      } else if (t === "tool-call") {
        send({
          type: "tool_call",
          toolCallId: (p as { toolCallId?: string }).toolCallId,
          tool: (p as { toolName?: string }).toolName,
          args: (p as { args?: unknown }).args,
        });
      } else if (t === "tool-result") {
        send({
          type: "tool_result",
          toolCallId: (p as { toolCallId?: string }).toolCallId,
          tool: (p as { toolName?: string }).toolName,
          result: (p as { result?: unknown }).result,
        });
      }
      // ignoramos finish/start/etc — el done explícito lo emitimos abajo
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
