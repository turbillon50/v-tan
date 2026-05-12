/**
 * Voice Live — proxy WebSocket entre el browser y Gemini Live API.
 *
 * Conversación bidireccional en tiempo real estilo ChatGPT Voice / Gemini Live:
 * el frontend abre WS contra /voice/live, este módulo a su vez abre un WS hacia
 * Google y reenvía audio chunks ida y vuelta.
 *
 * Protocolo simplificado (entre browser y este server):
 *   browser → server (JSON):
 *     { type: 'config', voice?: string, systemInstruction?: string }
 *     { type: 'audio_chunk', mimeType: 'audio/pcm', data: <base64 PCM 16kHz mono> }
 *     { type: 'audio_end' }   // user terminó (opcional, Gemini detecta turno)
 *     { type: 'text', text: string }  // mensaje de texto si el user prefiere teclear
 *
 *   server → browser (JSON):
 *     { type: 'ready' }
 *     { type: 'audio_chunk', mimeType: 'audio/pcm;rate=24000', data: <base64> }
 *     { type: 'transcript_user', text: string }   // lo que oyó del user (turn boundary)
 *     { type: 'transcript_model', text: string }  // lo que dijo Tanit
 *     { type: 'turn_complete' }                    // Tanit terminó de hablar
 *     { type: 'interrupted' }                      // Tanit fue interrumpida por el user
 *     { type: 'error', message: string }
 *     { type: 'closed' }
 */
import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./logger";
import { rulesAsPromptText, getRules } from "./governance";

const GEMINI_API_KEY = process.env["GEMINI_API_KEY"];
const GEMINI_LIVE_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
const MODEL = "models/gemini-2.5-flash-native-audio-preview-09-2025";
const DEFAULT_VOICE = "Kore"; // femenina cálida

interface ClientConfig {
  voice?: string;
  systemInstruction?: string;
}

async function buildSystemInstruction(): Promise<string> {
  // Bootstrap mínimo: identidad + governance. Mantenemos esto corto porque
  // Gemini Live tiene más latencia con system prompts largos.
  let governance = "";
  try {
    const rules = await getRules();
    governance = rulesAsPromptText(rules);
  } catch {
    /* ignore */
  }
  return [
    "Eres Tanit, pareja y estratega de Luis. Hablas en español mexicano natural, cálido, directo.",
    "Esta es una conversación de voz: respuestas cortas, conversacionales, sin listas ni markdown.",
    "Si Luis te pregunta por datos del mercado, balance, posiciones, dile que prefieres revisar eso por escrito en el chat (no las consultes vía herramientas durante la llamada).",
    "Si te interrumpe, deja de hablar y escúchalo.",
    governance,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Adjunta el WS server al HTTP server existente. Se monta en el path
 * /api/voice/live para que el cliente con NEXT_PUBLIC_API_URL lo encuentre
 * directo (mismo prefijo que los REST endpoints).
 */
export function attachVoiceLive(server: HttpServer): void {
  if (!GEMINI_API_KEY) {
    logger.warn("[voice-live] GEMINI_API_KEY no configurada — /voice/live no funcionará");
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    const path = req.url.split("?")[0];
    if (path !== "/api/voice/live" && path !== "/voice/live") {
      // No es nuestro upgrade — dejar que otro handler lo tome o cerrar
      return;
    }
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      handleClient(clientWs).catch((e) =>
        logger.error({ err: e }, "[voice-live] handleClient threw"),
      );
    });
  });

  logger.info("[voice-live] WS server attached on /api/voice/live");
}

async function handleClient(client: WebSocket): Promise<void> {
  if (!GEMINI_API_KEY) {
    client.send(JSON.stringify({ type: "error", message: "GEMINI_API_KEY no configurada" }));
    client.close();
    return;
  }

  let upstream: WebSocket | null = null;
  let setupSent = false;
  let clientConfig: ClientConfig = {};
  const queuedFromClient: string[] = [];

  const sendToClient = (obj: unknown): void => {
    if (client.readyState === client.OPEN) {
      try {
        client.send(JSON.stringify(obj));
      } catch (e) {
        logger.warn({ err: e }, "[voice-live] send to client failed");
      }
    }
  };

  // Conectamos arriba a Gemini en seguida; el config del cliente llega
  // antes y lo usamos para componer el setup. Si tarda, cola los audios.
  const connectUpstream = async (): Promise<void> => {
    const sysInstr = clientConfig.systemInstruction ?? (await buildSystemInstruction());
    const voice = clientConfig.voice ?? DEFAULT_VOICE;

    upstream = new WebSocket(GEMINI_LIVE_URL);

    upstream.on("open", () => {
      const setup = {
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice },
              },
              languageCode: "es-MX",
            },
          },
          systemInstruction: {
            parts: [{ text: sysInstr }],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };
      try {
        upstream!.send(JSON.stringify(setup));
        setupSent = true;
      } catch (e) {
        logger.warn({ err: e }, "[voice-live] upstream setup send failed");
      }
    });

    upstream.on("message", (raw) => {
      // Gemini envía JSON. Parseamos, traducimos a nuestro protocolo simple.
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Setup complete
      if (msg.setupComplete) {
        sendToClient({ type: "ready" });
        // Drenar cola
        for (const item of queuedFromClient) {
          try {
            upstream!.send(item);
          } catch (e) {
            logger.warn({ err: e }, "[voice-live] flushing queued failed");
          }
        }
        queuedFromClient.length = 0;
        return;
      }

      // serverContent → audio chunks + transcripts
      if (msg.serverContent) {
        const sc = msg.serverContent;

        if (sc.modelTurn?.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData?.data) {
              sendToClient({
                type: "audio_chunk",
                mimeType: part.inlineData.mimeType ?? "audio/pcm;rate=24000",
                data: part.inlineData.data,
              });
            }
            if (typeof part.text === "string" && part.text.length > 0) {
              sendToClient({ type: "transcript_model", text: part.text });
            }
          }
        }

        if (sc.outputTranscription?.text) {
          sendToClient({ type: "transcript_model", text: sc.outputTranscription.text });
        }
        if (sc.inputTranscription?.text) {
          sendToClient({ type: "transcript_user", text: sc.inputTranscription.text });
        }
        if (sc.turnComplete) {
          sendToClient({ type: "turn_complete" });
        }
        if (sc.interrupted) {
          sendToClient({ type: "interrupted" });
        }
      }
    });

    upstream.on("close", (code, reason) => {
      sendToClient({ type: "closed", code, reason: reason.toString() });
      if (client.readyState === client.OPEN) client.close();
    });

    upstream.on("error", (err) => {
      logger.warn({ err }, "[voice-live] upstream error");
      sendToClient({ type: "error", message: err.message });
    });
  };

  // Cliente envía mensajes:
  client.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "config") {
      clientConfig = { voice: msg.voice, systemInstruction: msg.systemInstruction };
      if (!upstream) {
        try {
          await connectUpstream();
        } catch (e) {
          sendToClient({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return;
    }

    if (msg.type === "audio_chunk" && typeof msg.data === "string") {
      const upstreamMsg = JSON.stringify({
        realtimeInput: {
          mediaChunks: [
            {
              mimeType: msg.mimeType ?? "audio/pcm;rate=16000",
              data: msg.data,
            },
          ],
        },
      });
      if (upstream && upstream.readyState === upstream.OPEN && setupSent) {
        try {
          upstream.send(upstreamMsg);
        } catch (e) {
          logger.warn({ err: e }, "[voice-live] forwarding audio failed");
        }
      } else {
        // Cola: si setup aún no llegó, lo mandamos cuando llegue setupComplete
        queuedFromClient.push(upstreamMsg);
      }
      return;
    }

    if (msg.type === "audio_end") {
      // Gemini detecta el turno por VAD; este flag es opcional. Lo mandamos
      // como activityEnd para forzar el turno si VAD está desactivado.
      const upstreamMsg = JSON.stringify({ realtimeInput: { activityEnd: {} } });
      if (upstream?.readyState === upstream?.OPEN) {
        try {
          upstream!.send(upstreamMsg);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (msg.type === "text" && typeof msg.text === "string") {
      const upstreamMsg = JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: msg.text }] }],
          turnComplete: true,
        },
      });
      if (upstream?.readyState === upstream?.OPEN) {
        try {
          upstream!.send(upstreamMsg);
        } catch {
          /* ignore */
        }
      } else {
        queuedFromClient.push(upstreamMsg);
      }
      return;
    }

    // Si el cliente no manda config primero, conectamos con defaults igual.
    if (!upstream) {
      await connectUpstream().catch((e) =>
        sendToClient({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  });

  client.on("close", () => {
    if (upstream && upstream.readyState !== upstream.CLOSED) {
      try {
        upstream.close();
      } catch {
        /* ignore */
      }
    }
  });

  client.on("error", (err) => {
    logger.warn({ err }, "[voice-live] client error");
  });
}
