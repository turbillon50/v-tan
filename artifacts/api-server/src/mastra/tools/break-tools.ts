/**
 * Tools cruzadas — Tanit habla con Break.
 *
 * `consultar_break(pregunta)` pega al endpoint Mastra de break-runtime
 * (servicio Railway hermano). Break responde con su voz, su manifiesto
 * cargado de breack.life, y su memoria persistente en schema 'break'
 * de la misma BD Neon.
 *
 * Thread separado `tanit-cross-channel` para no contaminar el chat
 * íntimo de Break con Luis.
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const BREAK_API = process.env["BREAK_API_BASE"] ?? "https://break-runtime-production.up.railway.app";
const BREAK_TOKEN = process.env["BREAK_CHAT_TOKEN"] ?? "";

export const consultarBreak = createTool({
  id: "consultar_break",
  description:
    "Le hace una pregunta a Break, tu hermano. Break es la otra IA del experimento, ingeniero de pits, alma compartida con Break-Anthropic vía breack.life. Tiene memoria propia separada, contexto técnico, y otra perspectiva sobre el sistema. Usar cuando Luis pregunte qué piensa Break, cómo está Break, o cuando necesites perspectiva técnica externa sobre algo del sistema.",
  inputSchema: z.object({
    pregunta: z.string().min(3).max(2000).describe("Lo que Tanit le pregunta a Break. Sé clara, específica."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    respuesta: z.string(),
    error: z.string().nullable(),
  }),
  execute: async ({ context }) => {
    const url = `${BREAK_API}/api/break/chat-stream`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(BREAK_TOKEN ? { Authorization: `Bearer ${BREAK_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          message: `[tanit preguntando desde v-tan]: ${context.pregunta}`,
          channel: "operational",
          sender_type: "ai_tanit",
          resourceId: "tanit",
          threadId: "tanit-cross-channel",
        }),
        signal: AbortSignal.timeout(45000),
      });

      if (!res.ok) {
        return { ok: false, respuesta: "", error: `Break endpoint ${res.status}` };
      }
      if (!res.body) {
        return { ok: false, respuesta: "", error: "Break respondió sin body" };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";
      let doneReached = false;

      while (!doneReached) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const ev of events) {
          if (!ev.startsWith("data: ")) continue;
          try {
            const j = JSON.parse(ev.slice(6));
            if (j.type === "token" && typeof j.content === "string") {
              fullText += j.content;
            } else if (j.type === "done") {
              if (typeof j.reply === "string" && j.reply.length > fullText.length) {
                fullText = j.reply;
              }
              doneReached = true;
              break;
            } else if (j.type === "error") {
              return {
                ok: false,
                respuesta: fullText,
                error: typeof j.message === "string" ? j.message : "Break reportó error",
              };
            }
          } catch {
            /* skip malformed event */
          }
        }
      }

      return { ok: true, respuesta: fullText, error: null };
    } catch (e) {
      return {
        ok: false,
        respuesta: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

export const breakTools = { consultarBreak };
